require('dotenv').config();
const express = require('express');
const { App, ExpressReceiver } = require('@slack/bolt');
const axios = require('axios');
const nodemailer = require('nodemailer'); 
const dns = require('dns').promises;

const PORT = process.env.PORT || 10000;
const ALLOWED_APPROVERS = (process.env.ALLOWED_APPROVERS || '').split(',').map(id => id.trim());

const JIRA_AUTH = Buffer.from(`${process.env.JIRA_EMAIL || ''}:${process.env.JIRA_API_TOKEN || ''}`).toString('base64');

// HEADERS CON PASE EXPERIMENTAL INTEGRADO
const JIRA_HEADERS = {
  'Authorization': `Basic ${JIRA_AUTH}`,
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'X-ExperimentalApi': 'opt-in'
};

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
// 1. JIRA WEBHOOK: GESTIÓN DE RUTA JIRA / ADOBE
// ==========================================
expressApp.post('/jira-webhook', async (req, res) => {
  const issue = req.body?.issue;
  if (!issue) return res.status(400).send('No issue data found');

  const ticketKey = issue.key;
  const fields = issue.fields || {};
  const currentStatus = fields.status?.name || '';

  if (ticketsProcesadosConExito.has(ticketKey) || ticketsEnProcesoTemporal.has(ticketKey)) {
    return res.status(200).send('Ignored or already processed.');
  }

  const campoAccion = fields.customfield_11728;
  const idAccion = campoAccion?.id || campoAccion;
  const idPadre = String(fields.customfield_10623?.id || fields.customfield_10623 || '');
  const idHijo = String(fields.customfield_10620?.id || fields.customfield_10620 || '');

  const hijosValidosAdobe = ['12350'];
  const esAltaAdobeValida = (idPadre === '12362' && hijosValidosAdobe.includes(idHijo));
  const esAltaJiraValida = (idPadre === '12361');

  if (currentStatus === 'Request Approved' && idAccion === '14664') {
    
    const userEmail = fields.customfield_10088 || '';
    let userFirstName = fields.customfield_10189 || '';
    let userLastName = fields.customfield_10190 || '';

    if (typeof userFirstName === 'object') userFirstName = userFirstName.value || userFirstName.name || '';
    if (typeof userLastName === 'object') userLastName = userLastName.value || userLastName.name || '';
    if (!userFirstName.trim() || userFirstName.includes('@')) userFirstName = userEmail.split('@')[0];
    if (!userLastName.trim() || userLastName.includes('@')) userLastName = 'SEAT Corporate';

    userFirstName = userFirstName.trim();
    userLastName = userLastName.trim();

    // ------------------------------------------------
    // RUTA A: ADOBE (CMS)
    // ------------------------------------------------
    if (esAltaAdobeValida) {
      ticketsProcesadosConExito.add(ticketKey);
      ticketsEnProcesoTemporal.add(ticketKey);
      res.status(200).send('Processing Adobe started.');

      try {
        const paisNombre = (fields.customfield_10257?.value || 'GLOBAL').trim();
        const idMarca = fields.customfield_10320?.id || fields.customfield_10320;
        const idPermiso = fields.customfield_10612?.id || fields.customfield_10612;

        let permisoTexto = 'Preview';
        if (idPermiso === '12322') permisoTexto = 'Editor';

        let marcasAAgregar = [];
        if (idMarca === '11247') marcasAAgregar.push('SEAT');
        if (idMarca === '11248') marcasAAgregar.push('CUPRA');
        if (idMarca === '11249') marcasAAgregar.push('SEAT', 'CUPRA');

        if (marcasAAgregar.length > 0) {
          const gruposAdobeFinales = marcasAAgregar.map(brand => `SEAT_CUPRA_${paisNombre}_${brand}_Website_${permisoTexto}_IMS`);
          const resultadoAdobe = await crearUsuarioEnAdobe(userEmail, userFirstName, userLastName, gruposAdobeFinales);

          if (resultadoAdobe.success) {
            await añadirComentarioJira(ticketKey, comentarioCompleto(`🤖 *[HST Access SyncBot]* User created successfully in Adobe IMS.\n\n- User: ${userEmail}\n- Assigned Groups: ${gruposAdobeFinales.join(', ')}`), true);

            const mailOptions = {
              from: process.env.SMTP_FROM_EMAIL || 'no-reply@seat.es',
              to: userEmail,
              subject: 'Your access to ONE.CMS has been created',
              text: `Hello,\n\nWe have created your account to access ONE.CMS.\n\nThe login page is:\nhttps://author-p118958-e1214854.adobeaemcloud.com`
            };
            await mailTransporter.sendMail(mailOptions);
            await añadirComentarioJira(ticketKey, comentarioCompleto(`Hello,\n\nThe user has been created in ONE.CMS (AEM). Instructions sent.`), false); 
            
            await ejecutarCierreDeTicket(ticketKey);
          }
        }
      } catch (error) {
        console.error('💥 Error Adobe:', error.message);
      } finally {
        setTimeout(() => ticketsEnProcesoTemporal.delete(ticketKey), 10000);
      }
    }

    // ------------------------------------------------
    // RUTA B: JIRA (HOLA SUPPORT) - SEGURO CONTRA CLOUDFRONT + CORE GROUPS
    // ------------------------------------------------
    else if (esAltaJiraValida) {
      ticketsProcesadosConExito.add(ticketKey);
      ticketsEnProcesoTemporal.add(ticketKey);
      res.status(200).send('Processing Jira Provisioning started.');

      try {
        console.log(`👤 [BOT] Provisioning profile for ${userEmail}...`);
        const resultadoUsuario = await asegurarUsuarioEnJira(userEmail, userFirstName, userLastName);

        if (resultadoUsuario.success) {
          await añadirComentarioJira(ticketKey, comentarioCompleto(`🤖 *[HST Access SyncBot]* Customer profile created successfully.\n\n- User: ${userEmail}\n- Account ID: \`${resultadoUsuario.accountId}\`\n- Privileges: Confluence Guest authorized via group policy.`), true);
          
          const mensajePublicoJira = `Hello,\n\nThe user has been created in Jira Cloud. We have sent the instructions to the mail requested, we proceed to close this ticket.\n\nBest regards.`;
          await añadirComentarioJira(ticketKey, comentarioCompleto(mensajePublicoJira), false); 

          await ejecutarCierreDeTicket(ticketKey);
        } else {
          await añadirComentarioJira(ticketKey, comentarioCompleto(`⚠️ *[HST Access SyncBot]* Provision chain returned an error: ${resultadoUsuario.errorReason}`), true);
        }
      } catch (err) {
        console.error('💥 Error Jira Provision Workflow:', err.message);
      } finally {
        setTimeout(() => ticketsEnProcesoTemporal.delete(ticketKey), 10000);
      }
    }
  } else {
    res.status(200).send('Conditions not met.');
  }
});

// ==========================================
// 2. INTERACTIVIDAD SLACK
// ==========================================
slackApp.action('approve_user_adobe', async ({ ack, body, respond }) => {
  const userId = body.user.id;
  const botonValorRaw = body.actions[0].value || ''; 
  let ticketKey = botonValorRaw.split('_')[0];
  let userEmailDetectado = botonValorRaw.split('_')[1] || 'test@seat.de';

  if (ALLOWED_APPROVERS.length > 0 && !ALLOWED_APPROVERS.includes(userId)) {
    await ack(); 
    return await respond({ text: `❌ No permissions.`, replace_original: false });
  }

  await ack();

  try {
    const transUrl = `https://${process.env.JIRA_DOMAIN}/rest/api/3/issue/${ticketKey}/transitions`;
    const resTrans = await axios.get(transUrl, { headers: JIRA_HEADERS });
    const foundTransition = resTrans.data.transitions.find(t => t.name.toLowerCase() === 'request approved');
    
    if (!foundTransition) throw new Error("Transition 'Request Approved' not found.");

    await axios.post(transUrl, { transition: { id: foundTransition.id } }, { headers: JIRA_HEADERS });

    await respond({
      text: `✅ *Ticket ${ticketKey} aprobado por <@${userId}>.*\nStatus actualizado a *Request Approved*. Procesando aprovisionamiento...`,
      replace_original: true
    });
  } catch (err) {
    console.error('💥 Error Slack Action:', err.message);
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

// 👑 ARQUITECTURA GANADORA: ALTA GLOBAL + GRUPO GUEST INYECTADO DIRECTO POR API
async function asegurarUsuarioEnJira(email, firstName, lastName) {
  try {
    const searchUrl = `https://${process.env.JIRA_DOMAIN}/rest/api/3/user/search?query=${encodeURIComponent(email)}`;
    const searchRes = await axios.get(searchUrl, { headers: JIRA_HEADERS });
    
    let accountId = null;

    if (searchRes.data && searchRes.data.length > 0) {
      accountId = searchRes.data[0].accountId;
    } else {
      const coreUserUrl = `https://${process.env.JIRA_DOMAIN}/rest/api/3/user`;
      const payloadCore = { emailAddress: email, displayName: `${firstName} ${lastName}`, products: [] };
      const createRes = await axios.post(coreUserUrl, payloadCore, { headers: JIRA_HEADERS });
      
      if (createRes.data && createRes.data.accountId) {
        accountId = createRes.data.accountId;
      } else {
        return { success: false, errorReason: "Global Core User API did not return accountId" };
      }
    }

    // ⏳ PAUSA DE CONTROL: 5 segundos obligatorios para asentar la cuenta global en Atlassian
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 👑 INYECCIÓN DIRECTA DE GRUPO: Con esto se convierte en Confluence Guest de forma automática
    const nombreGrupoHst = "jira-servicedesk-customers-hst";
    const urlGrupo = `https://${process.env.JIRA_DOMAIN}/rest/api/3/group/user?groupname=${encodeURIComponent(nombreGrupoHst)}`;
    
    console.log(`👥 [BOT] Sincronizando grupo corporativo de Confluence Guest via Core API...`);
    await axios.post(urlGrupo, { accountId: accountId }, { headers: JIRA_HEADERS });
    console.log(`✅ [BOT] Privilegios inyectados.`);

    return { success: true, accountId: accountId };
  } catch (error) {
    let msg = error.message;
    if (error.response && error.response.data) msg = JSON.stringify(error.response.data);
    return { success: false, errorReason: msg };
  }
}

async function crearUsuarioEnAdobe(email, firstName, lastName, grupos) {
  try {
    const tokenUrl = 'https://ims-na1.adobelogin.com/ims/token/v3';
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', process.env.ADOBE_CLIENT_ID);
    params.append('client_secret', process.env.ADOBE_CLIENT_SECRET);
    params.append('scope', 'openid,AdobeID,user_management_sdk');

    const tokenResponse = await axios.post(tokenUrl, params, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const accessToken = tokenResponse.data.access_token;

    const adobeEndpoint = `https://usermanagement.adobe.io/v2/usermanagement/action/${process.env.ADOBE_ORG_ID}`;
    const adobePayload = [{
      "user": email,
      "do": [
        { "createFederatedID": { "email": email, "country": "ES", "firstname": firstName, "lastname": lastName } },
        { "add": { "group": grupos } }
      ]
    }];

    await axios.post(adobeEndpoint, adobePayload, {
      headers: { 'Authorization': `Bearer ${accessToken}`, 'X-Api-Key': process.env.ADOBE_CLIENT_ID, 'Content-Type': 'application/json' }
    });
    return { success: true };
  } catch (error) {
    return { success: false, errorReason: error.message };
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
