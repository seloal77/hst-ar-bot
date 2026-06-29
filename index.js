// index.js
require('dotenv').config();
const express = require('express');
const { App, ExpressReceiver } = require('@slack/bolt');
const axios = require('axios');
const nodemailer = require('nodemailer'); 
const dns = require('dns').promises;

// 📦 IMPORTACIÓN DE NUESTROS SERVICIOS MODULARES
const { asegurarUsuarioEnJira, JIRA_HEADERS } = require('./jiraService');
const { crearUsuarioEnAdobe } = require('./aemService');

const PORT = process.env.PORT || 10000;
const ALLOWED_APPROVERS = (process.env.ALLOWED_APPROVERS || '').split(',').map(id => id.trim());

const ticketsProcesadosConExito = new Set();
const ticketsEnProcesoTemporal = new Set();

const mailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com', 
  port: process.env.SMTP_PORT || 587,
  secure: process.env.SMTP_SECURE === 'true', 
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || ''
  }
});

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET || 'dummy_secret',
  processBeforeResponse: true
});

const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver: receiver,
  socketMode: false 
});

const expressApp = receiver.app;
expressApp.use(express.json());

expressApp.get('/', (req, res) => {
  res.status(200).send('🚀 HST Access SyncBot is online.');
});

// ==========================================
// 1. JIRA WEBHOOK: ALTA REAL EN ADOBE / JIRA
// ==========================================
expressApp.post('/jira-webhook', async (req, res) => {
  const issue = req.body?.issue;
  if (!issue) return res.status(400).send('No issue data found');

  const ticketKey = issue.key;
  const fields = issue.fields || {};
  const currentStatus = fields.status?.name || '';

  if (ticketsProcesadosConExito.has(ticketKey)) {
    console.info(`ℹ️ [INFO] Ticket ${ticketKey} ya fue procesado correctamente.`);
    return res.status(200).send('Already processed in the past.');
  }

  if (ticketsEnProcesoTemporal.has(ticketKey)) {
    return res.status(200).send('Duplicate request ignored.');
  }

  const campoAccion = fields.customfield_11728;
  const idAccion = campoAccion?.id || campoAccion;

  if (idAccion === '14665') {
    return res.status(200).send('Manual deletion request. No action taken.');
  }

  const idPadre = String(fields.customfield_10623?.id || fields.customfield_10623 || '');
  const idHijo = String(fields.customfield_10620?.id || fields.customfield_10620 || '');

  const hijosValidosAdobe = ['12350'];
  const esAltaAdobeValida = (idPadre === '12362' && hijosValidosAdobe.includes(idHijo));
  const esAltaJiraValida = (idPadre === '12361');

  if (currentStatus === 'Request Approved' && idAccion === '14664' && (esAltaAdobeValida || esAltaJiraValida)) {
    
    const userEmail = fields.customfield_10088 || '';
    let userFirstName = '';
    let userLastName = '';

    if (fields.customfield_10189) {
      userFirstName = typeof fields.customfield_10189 === 'object' ? (fields.customfield_10189.value || fields.customfield_10189.name || '') : fields.customfield_10189;
    }
    if (fields.customfield_10190) {
      userLastName = typeof fields.customfield_10190 === 'object' ? (fields.customfield_10190.value || fields.customfield_10190.name || '') : fields.customfield_10190;
    }

    if (!userFirstName.trim() || userFirstName.includes('@')) userFirstName = userEmail.split('@')[0];
    if (!userLastName.trim() || userLastName.includes('@')) userLastName = 'SEAT Corporate';

    userFirstName = userFirstName.trim();
    userLastName = userLastName.trim();

    // ------------------------------------------------
    // RUTA A: ADOBE (CMS) -> LLAMADA AL MÓDULO EXTERNO
    // ------------------------------------------------
    if (esAltaAdobeValida) {
      ticketsProcesadosConExito.add(ticketKey);
      ticketsEnProcesoTemporal.add(ticketKey);
      res.status(200).send('Processing started.');

      try {
        const campoPais = fields.customfield_10257; 
        const campoMarca = fields.customfield_10320; 
        const campoPermiso = fields.customfield_10612;

        const paisNombre = (campoPais?.value || 'GLOBAL').trim();
        const idMarca = campoMarca?.id || campoMarca;
        const idPermiso = campoPermiso?.id || campoPermiso;

        let permisoTexto = 'Preview';
        if (idPermiso === '12322') permisoTexto = 'Editor';

        let marcasAAgregar = [];
        if (idMarca === '11247') marcasAAgregar.push('SEAT');
        if (idMarca === '11248') marcasAAgregar.push('CUPRA');
        if (idMarca === '11249') marcasAAgregar.push('SEAT', 'CUPRA');

        if (marcasAAgregar.length === 0) return console.log('⚠️ No se han detectado marcas válidas.');

        const gruposAdobeFinales = marcasAAgregar.map(brand => `SEAT_CUPRA_${paisNombre}_${brand}_Website_${permisoTexto}_IMS`);

        // Ejecución modular desde aemService
        const resultadoAdobe = await crearUsuarioEnAdobe(userEmail, userFirstName, userLastName, gruposAdobeFinales);

        if (resultadoAdobe.success) {
          const listaGruposTexto = gruposAdobeFinales.map(g => `\`${g}\``).join(', ');
          
          await añadirComentarioJira(ticketKey, comentarioCompleto(`🤖 *[HST Access SyncBot]* User created successfully in Adobe IMS.\n\n- User: ${userEmail}\n- Name: ${userFirstName} ${userLastName}\n- Assigned Groups: ${listaGruposTexto}`), true);

          const mailOptions = {
            from: process.env.SMTP_FROM_EMAIL || 'no-reply@seat.es',
            to: userEmail,
            subject: 'Your access to ONE.CMS has been created',
            text: `Hello,\n\nWe have created your account to access ONE.CMS.\n\nThe login page is:\nhttps://author-p118958-e1214854.adobeaemcloud.com`
          };
          await mailTransporter.sendMail(mailOptions);

          const mensajePublico = `Hello,\n\nThe user has been created in ONE.CMS (AEM). We have sent the instructions to the mail requested, we proceed to close this ticket.\n\nBest regards.`;
          await añadirComentarioJira(ticketKey, comentarioCompleto(mensajePublico), false); 

          await ejecutarCierreDeTicket(ticketKey);

        } else {
          const errorMsg = resultadoAdobe.errorReason || '';
          let diagnosticoSoporte = `⚠️ *[HST Access SyncBot]* Auto-provisioning failed in Adobe Admin Console.\n\n📌 *IT Diagnostic:* ${errorMsg}`;
          await añadirComentarioJira(ticketKey, comentarioCompleto(diagnosticoSoporte), true);
        }

      } catch (error) {
        console.error('💥 Error Webhook Adobe:', error.message);
      } finally {
        setTimeout(() => ticketsEnProcesoTemporal.delete(ticketKey), 10000);
      }
    }

    // ------------------------------------------------
    // RUTA B: JIRA (HOLA SUPPORT) -> LLAMADA AL MÓDULO EXTERNO
    // ------------------------------------------------
    else if (esAltaJiraValida) {
      const emailDomain = userEmail.split('@')[1];

      if (emailDomain) {
        try {
          const mxRecords = await dns.resolveMx(emailDomain);
          if (!mxRecords || mxRecords.length === 0) throw new Error("No MX records");
        } catch (dnsErr) {
          await añadirComentarioJira(ticketKey, comentarioCompleto(`⚠️ *[HST Access SyncBot]* Proceso interrumpido.\n\nLa dirección de correo electrónico proporcionada (\`${userEmail}\`) pertenece a un dominio inválido o ficticio. Por favor, rectifica el campo para volver a procesarlo.`), true);
          return res.status(200).send('Invalid email domain.');
        }
      }

      ticketsProcesadosConExito.add(ticketKey);
      ticketsEnProcesoTemporal.add(ticketKey);
      res.status(200).send('Processing Jira started.');

      try {
        // Ejecución modular desde jiraService
        const resultadoUsuario = await asegurarUsuarioEnJira(userEmail, userFirstName, userLastName);

        if (!resultadoUsuario.success) {
          await añadirComentarioJira(ticketKey, comentarioCompleto(`⚠️ *[HST Access SyncBot]* Failed to complete provisioning.\n\n- Reason: ${resultadoUsuario.errorReason}`), true);
          return;
        }

        await añadirComentarioJira(ticketKey, comentarioCompleto(`🤖 *[HST Access SyncBot]* User profile created successfully in Jira Cloud.\n\n- User: ${userEmail}\n- Name: ${userFirstName} ${userLastName}\n- Account ID: \`${resultadoUsuario.accountId}\``), true);
        
        const mensajePublicoJira = `Hello,\n\nThe user has been created in Jira Cloud. We have sent the instructions to the mail requested, we proceed to close this ticket.\n\nBest regards.`;
        await añadirComentarioJira(ticketKey, comentarioCompleto(mensajePublicoJira), false); 

        await ejecutarCierreDeTicket(ticketKey);

      } catch (err) { 
        await añadirComentarioJira(ticketKey, comentarioCompleto(`⚠️ *[HST Access SyncBot]* Error executing workflow.\n\n- Details: ${err.message}`), true);
      } finally { 
        setTimeout(() => ticketsEnProcesoTemporal.delete(ticketKey), 10000); 
      }
    }

  } else {
    res.status(200).send('Conditions not met.');
  }
});

// ==========================================
// 2. INTERACTIVIDAD SLACK (BOLT ACTIONS)
// ==========================================
slackApp.action('approve_user_adobe', async ({ ack, body, respond }) => {
  const userId = body.user.id;
  const botonValorRaw = body.actions[0].value || ''; 
  let ticketKey = botonValorRaw.split('_')[0];
  let userEmailDetectado = botonValorRaw.split('_')[1] || 'test@seat.de';

  const ticketUrl = `https://` + process.env.JIRA_DOMAIN + `/browse/${ticketKey}`;

  if (ALLOWED_APPROVERS.length > 0 && !ALLOWED_APPROVERS.includes(userId)) {
    await ack(); 
    return await respond({ text: `❌ Sorry, you do not have permission.`, replace_original: false });
  }

  await ack({
    text: `*New access request*\n• *Ticket:* <${ticketUrl}|${ticketKey}>\n\n*User Profile requested:*\n• *Mail:* ${userEmailDetectado}\n\n🔄 _Processing approval (Requested by <@${userId}>)..._`,
    replace_original: true
  });

  try {
    const ticketRes = await axios.get(`https://${process.env.JIRA_DOMAIN}/rest/api/3/issue/${ticketKey}`, { headers: JIRA_HEADERS });
    const fields = ticketRes.data?.fields || {};

    const idPadre = String(fields.customfield_10623?.id || fields.customfield_10623 || '');
    const cabeceraPlataforma = idPadre === '12361' ? 'New access request for HOLA Support' : 'New access request for One.CMS (AEM)';

    let userFirstName = '';
    let userLastName = '';

    if (fields.customfield_10189) {
      userFirstName = typeof fields.customfield_10189 === 'object' ? (fields.customfield_10189.value || fields.customfield_10189.name || '') : fields.customfield_10189;
    }
    if (fields.customfield_10190) {
      userLastName = typeof fields.customfield_10190 === 'object' ? (fields.customfield_10190.value || fields.customfield_10190.name || '') : fields.customfield_10190;
    }

    if (!userFirstName.trim()) userFirstName = userEmailDetectado.split('@')[0];
    if (!userLastName.trim()) userLastName = 'SEAT Corporate';

    const mercado = (fields.customfield_10257?.value || 'GLOBAL').trim();
    const permisoOriginal = (fields.customfield_10612?.value || fields.customfield_10612 || 'Preview').trim();

    let permisoSlack = 'Preview';
    if (permisoOriginal.toLowerCase() === 'editor') permisoSlack = 'Edition (+preview)';
    if (idPadre === '12361') permisoSlack = 'Customer standard access';

    const transUrl = `https://${process.env.JIRA_DOMAIN}/rest/api/3/issue/${ticketKey}/transitions`;
    const resTrans = await axios.get(transUrl, { headers: JIRA_HEADERS });
    
    const foundTransition = resTrans.data.transitions.find(t => t.name.toLowerCase() === 'request approved');
    if (!foundTransition) throw new Error("Transition 'Request Approved' not found.");

    await axios.post(transUrl, { transition: { id: foundTransition.id } }, { headers: JIRA_HEADERS });

    await respond({
      text: `*${cabeceraPlataforma}*\n• *Ticket:* <${ticketUrl}|${ticketKey}>\n\n*User Profile managed:*\n• *Mail:* ${userEmailDetectado}\n• *Name:* ${userFirstName.trim()} ${userLastName.trim()}\n• *Market:* ${mercado}\n• *Permission:* ${permisoSlack}\n\n✅ *Ticket approved by <@${userId}>.*\nStatus updated to *Request Approved*. Automated provisioning is now running in the background. Please check the Jira ticket comments for final results.`,
      replace_original: true
    });

  } catch (jiraError) {
    console.error('💥 Error Slack Action:', jiraError.message);
  }
});

async function ejecutarCierreDeTicket(ticketKey) {
  try {
    const urlTransiciones = `https://${process.env.JIRA_DOMAIN}/rest/api/3/issue/${ticketKey}/transitions`;
    await axios.post(urlTransiciones, { transition: { id: "61" } }, { headers: JIRA_HEADERS });
    await axios.post(urlTransiciones, { transition: { id: "151" } }, { headers: JIRA_HEADERS });
  } catch (err) {
    console.error(`💥 Error cerrando ticket:`, err.message);
  }
}

async function añadirComentarioJira(ticketKey, bodyContent, esInterno = true) {
  const url = `https://${process.env.JIRA_DOMAIN}/rest/api/3/issue/${ticketKey}/comment`;
  const payloadFinal = { ...bodyContent, properties: [{ key: "sd.public.comment", value: { internal: esInterno } }] };
  await axios.post(url, payloadFinal, { headers: JIRA_HEADERS });
}

function comentarioCompleto(texto) {
  return {
    body: {
      type: "doc", version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: texto }] }]
    }
  };
}

expressApp.listen(PORT, () => {
  console.log(`🚀 HST Access SyncBot running stably on port ${PORT}`);
});
