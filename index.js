require('dotenv').config();
const express = require('express');
const { App, ExpressReceiver } = require('@slack/bolt');
const axios = require('axios');
const nodemailer = require('nodemailer'); 

const PORT = process.env.PORT || 10000;
const ALLOWED_APPROVERS = (process.env.ALLOWED_APPROVERS || '').split(',').map(id => id.trim());

const JIRA_AUTH = Buffer.from(`${process.env.JIRA_EMAIL || ''}:${process.env.JIRA_API_TOKEN || ''}`).toString('base64');
const JIRA_HEADERS = {
  'Authorization': `Basic ${JIRA_AUTH}`,
  'Content-Type': 'application/json'
};

const ticketsProcesadosConExito = new Set();
const ticketsEnProcesoTemporal = new Set();

// Configuración del servicio de correo electrónico (Rellenar en tu .env de Render)
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

  // Control de duplicados inteligente (Evitamos pintar en rojo mensajes informativos)
  if (ticketsProcesadosConExito.has(ticketKey)) {
    console.info(`ℹ️ [INFO] Ticket ${ticketKey} ya fue procesado correctamente en el pasado. Ignorando duplicado de Jira de forma silenciosa.`);
    return res.status(200).send('Already processed in the past.');
  }

  if (ticketsEnProcesoTemporal.has(ticketKey)) {
    console.log(`⏳ [WEBHOOK] Ráfaga temporal detectada para ${ticketKey} (procesando actualmente).`);
    return res.status(200).send('Duplicate request ignored.');
  }

  const campoAccion = fields.customfield_11728;
  const idAccion = campoAccion?.id || campoAccion;

  if (idAccion === '14665') {
    console.log(`ℹ️ [JIRA WEBHOOK] Ticket ${ticketKey} es de tipo 'Delete current account'. No se realiza acción automática.`);
    return res.status(200).send('Manual deletion request. No action taken.');
  }

  const idPadre = String(fields.customfield_10623?.id || fields.customfield_10623 || '');
  const idHijo = String(fields.customfield_10620?.id || fields.customfield_10620 || '');

  const hijosValidosAdobe = ['12350'];
  const esAltaAdobeValida = (idPadre === '12362' && hijosValidosAdobe.includes(idHijo));
  const esAltaJiraValida = (idPadre === '12361');

  if (currentStatus === 'Request Approved' && idAccion === '14664' && (esAltaAdobeValida || esAltaJiraValida)) {
    
    const userEmail = fields.customfield_10088;
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
    // RUTA A: ADOBE (CMS)
    // ------------------------------------------------
    if (esAltaAdobeValida) {
      console.log(`📬 [WEBHOOK JIRA] ¡Petición de Alta válida recibida para ${ticketKey}! Activando bloqueos...`);
      
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

        console.log(`👥 [ADOBE] Intentando asignar al usuario ${userEmail} los grupos:`, gruposAdobeFinales);
        const resultadoAdobe = await crearUsuarioEnAdobe(userEmail, userFirstName, userLastName, gruposAdobeFinales);

        if (resultadoAdobe.success) {
          const listaGruposTexto = gruposAdobeFinales.map(g => `\`${g}\``).join(', ');
          
          // 1. Registro interno en el ticket para el equipo técnico
          await añadirComentarioJira(ticketKey, comentarioCompleto(`🤖 *[HST Access SyncBot]* User created successfully in Adobe IMS.\n\n- User: ${userEmail}\n- Name: ${userFirstName} ${userLastName}\n- Assigned Groups: ${listaGruposTexto}`), true);

          // 2. Enviar correo electrónico oficial con instrucciones
          console.log(`📧 [EMAIL] Enviando instrucciones de acceso a ${userEmail}...`);
          const mailOptions = {
            from: process.env.SMTP_FROM_EMAIL || 'no-reply@seat.es',
            to: userEmail,
            subject: 'Your access to ONE.CMS has been created',
            text: `Hello,\n\nWe have created your account to access ONE.CMS.\n\nThe login page is:\nhttps://author-p118958-e1214854.adobeaemcloud.com\n\nFor more info to the whole login process, please follow this link:\nwww.holamarkets.seat/space/HST/blog/3052208181/One.CMS+Migration`
          };
          await mailTransporter.sendMail(mailOptions);

          // 3. Comentario externo (público) de despedida en el ticket
          const mensajePublico = `Hello,\n\nThe user has been created in ONE.CMS (AEM). We have sent the instructions to the mail requested, we proceed to close this ticket.\n\nBest regards.`;
          await añadirComentarioJira(ticketKey, comentarioCompleto(mensajePublico), false); 

          // 4. Cierre automático del ticket en Jira (61 -> 151)
          await ejecutarCierreDeTicket(ticketKey);

        } else {
          const errorMsg = resultadoAdobe.errorReason || '';
          let diagnosticoSoporte = `⚠️ *[HST Access SyncBot]* Auto-provisioning failed in Adobe Admin Console.\n\n📌 *IT Diagnostic:* General error: \`${errorMsg}\`.`;
          if (errorMsg.includes("createFederatedID")) {
            diagnosticoSoporte = `⚠️ *[HST Access SyncBot]* Auto-provisioning failed in Adobe Admin Console.\n\n📌 *IT Diagnostic:* This user's email domain has corporate directory synchronization enabled...`;
          }
          await añadirComentarioJira(ticketKey, comentarioCompleto(diagnosticoSoporte), true);
        }

      } catch (error) {
        console.error('💥 [ERROR CRÍTICO WEBHOOK ADOBE]:', error.message);
      } finally {
        setTimeout(() => ticketsEnProcesoTemporal.delete(ticketKey), 10000);
      }
    }

    // ------------------------------------------------
    // RUTA B: JIRA (HOLA SUPPORT)
    // ------------------------------------------------
    else if (esAltaJiraValida) {
      console.log(`📬 [WEBHOOK JIRA] Processing Jira Customer provisioning for ${ticketKey}...`);
      ticketsProcesadosConExito.add(ticketKey);
      ticketsEnProcesoTemporal.add(ticketKey);
      res.status(200).send('Processing Jira started.');

      try {
        console.log(`👤 [BOT] Creating user ${userEmail} (${userFirstName} ${userLastName}) as a Customer...`);
        const resultadoUsuario = await asegurarUsuarioEnJira(userEmail, userFirstName, userLastName);

        if (!resultadoUsuario.success) {
          await añadirComentarioJira(ticketKey, comentarioCompleto(`⚠️ *[HST Access SyncBot]* Failed to create customer in Jira.\n\n- Reason: ${resultadoUsuario.errorReason}`), true);
          return;
        }

        const realAccountId = resultadoUsuario.accountId;
        console.log(`✅ [BOT] Customer profile active with ID: ${realAccountId}. Adding to Service Desk 122...`);

        // Mapeo exacto de la lógica de Java: añadir al Service Desk 122 mediante POST
        const serviceDeskId = "122"; 
        const urlAddSD = `https://${process.env.JIRA_DOMAIN}/rest/servicedeskapi/servicedesk/${serviceDeskId}/customer`;
        const payloadSD = { usernames: [userEmail] };

        await axios.post(urlAddSD, payloadSD, { headers: JIRA_HEADERS });
        console.log(`🎉 [BOT] User successfully mapped into Service Desk 122 registry.`);

        // 1. Registro interno en las notas del ticket para los agentes
        await añadirComentarioJira(ticketKey, comentarioCompleto(`🤖 *[HST Access SyncBot]* Customer created and mapped successfully in Jira Service Desk.\n\n- User: ${userEmail}\n- Name: ${userFirstName} ${userLastName}\n- Assigned Service Desk: ${serviceDeskId}\n- Access: Confluence Guest authorized via portal registry.`), true);
        
        // 2. Comentario externo público de cierre para el usuario
        const mensajePublicoJira = `Hello,\n\nThe user has been created in Jira Cloud. We have sent the instructions to the mail requested, we proceed to close this ticket.\n\nBest regards.`;
        await añadirComentarioJira(ticketKey, comentarioCompleto(mensajePublicoJira), false); 

        // 3. Cierre automático y encadenado del ticket (61 -> 151)
        await ejecutarCierreDeTicket(ticketKey);

      } catch (err) { 
        console.error('💥 Jira customer route error:', err.message);
        let errorDetails = err.message;
        if (err.response && err.response.data) errorDetails = JSON.stringify(err.response.data);
        await añadirComentarioJira(ticketKey, comentarioCompleto(`⚠️ *[HST Access SyncBot]* Error mapping user to Service Desk 122.\n\n- Details: ${errorDetails}`), true);
      } finally { 
        setTimeout(() => ticketsEnProcesoTemporal.delete(ticketKey), 10000); 
      }
    }

  } else {
    res.status(200).send('Conditions not met or Action Type excluded.');
  }
});

// ==========================================
// 2. INTERACTIVIDAD SLACK
// ==========================================
slackApp.action('approve_user_adobe', async ({ ack, body, respond }) => {
  const userId = body.user.id;
  const botonValorRaw = body.actions[0].value || ''; 
  let ticketKey = botonValorRaw;
  let userEmailDetectado = 'developer.test@seat.de'; 

  if (botonValorRaw.includes('_')) {
    const partes = botonValorRaw.split('_');
    ticketKey = partes[0];
    userEmailDetectado = partes[1];
  }

  const ticketUrl = `https://${process.env.JIRA_DOMAIN}/browse/${ticketKey}`;

  if (ALLOWED_APPROVERS.length > 0 && !ALLOWED_APPROVERS.includes(userId)) {
    await ack(); 
    return await respond({ text: `❌ Sorry, you do not have permission.`, replace_original: false });
  }

  await ack({
    text: `*New access request*\n• *Ticket:* <${ticketUrl}|${ticketKey}>\n\n*User Profile requested:*\n• *Mail:* ${userEmailDetectado}\n\n🔄 _Processing approval (Requested by <@${userId}>)..._`,
    replace_original: true
  });

  try {
    console.log(`🔍 [SLACK ACTION] Consultando detalles de ${ticketKey} en Jira...`);
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
    console.error('💥 [ERROR SLACK ACTION]:', jiraError.message);
    await respond({
      text: `*New access request*\n• *Ticket:* <${ticketUrl}|${ticketKey}>\n\n⚠️ *Slack action registered, but Jira update encountered an issue:* ${jiraError.message}`,
      replace_original: true
    });
  }
});

// ==========================================
// MOTOR AUTOMÁTICO DE TRANSICIONES (61 -> 151)
// ==========================================
async function ejecutarCierreDeTicket(ticketKey) {
  try {
    const urlTransiciones = `https://${process.env.JIRA_DOMAIN}/rest/api/3/issue/${ticketKey}/transitions`;
    
    // 1. Saltar a Prefixed (ID: 61)
    console.log(`🔄 [JIRA] Transicionando ticket ${ticketKey} a 'Prefixed' (ID: 61)...`);
    await axios.post(urlTransiciones, { transition: { id: "61" } }, { headers: JIRA_HEADERS });

    // 2. Saltar a Fixed (ID: 151)
    console.log(`🔒 [JIRA] Transicionando ticket ${ticketKey} a 'Fixed' (ID: 151)...`);
    await axios.post(urlTransiciones, { transition: { id: "151" } }, { headers: JIRA_HEADERS });
    
    console.log(`✅ [JIRA] Ticket ${ticketKey} cerrado correctamente.`);
  } catch (err) {
    console.error(`💥 [ERROR TRANSICIONES] Error cerrando el ticket ${ticketKey}:`, err.message);
  }
}

// ==========================================
// API AUXILIAR: ASEGURAR / CREAR USUARIO JIRA (VERSIÓN JSM CUSTOMER)
// ==========================================
async function asegurarUsuarioEnJira(email, firstName, lastName) {
  try {
    // Buscamos primero si ya existe en Atlassian para heredar su ID sin duplicar
    const searchUrl = `https://${process.env.JIRA_DOMAIN}/rest/api/3/user/search?query=${encodeURIComponent(email)}`;
    const searchRes = await axios.get(searchUrl, { headers: JIRA_HEADERS });
    
    if (searchRes.data && searchRes.data.length > 0) {
      return { success: true, accountId: searchRes.data[0].accountId };
    }

    // Si no existe, lo creamos como Customer usando la API de JSM (Esquiva el error 400 global)
    const customerUrl = `https://${process.env.JIRA_DOMAIN}/rest/servicedeskapi/customer`;
    const payload = {
      email: email,
      displayName: `${firstName} ${lastName}`
    };
    
    console.log(`➕ [JIRA] Generando ID de usuario mediante JSM Customer API...`);
    const createRes = await axios.post(customerUrl, payload, { headers: JIRA_HEADERS });
    
    if (createRes.data && createRes.data.accountId) {
      return { success: true, accountId: createRes.data.accountId };
    }
    return { success: false, errorReason: "JSM Customer API did not return an accountId" };
  } catch (error) {
    let msg = error.message;
    if (error.response && error.response.data) msg = JSON.stringify(error.response.data);
    return { success: false, errorReason: msg };
  }
}

// ==========================================
// API REAL DE ADOBE
// ==========================================
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

    const apiResponse = await axios.post(adobeEndpoint, adobePayload, {
      headers: { 'Authorization': `Bearer ${accessToken}`, 'X-Api-Key': process.env.ADOBE_CLIENT_ID, 'Content-Type': 'application/json' }
    });

    if (apiResponse.data?.completed === 0 && apiResponse.data?.errors?.length > 0) {
      const errorDetalle = apiResponse.data.errors[0];
      if (errorDetalle.errorCode === "error.user.already_in_org") return { success: true };
      return { success: false, errorReason: errorDetalle.message || errorDetalle.errorCode };
    }
    return { success: true };
  } catch (error) {
    let msg = error.message;
    if (error.response && error.response.data) msg = JSON.stringify(error.response.data);
    return { success: false, errorReason: msg };
  }
}

// Envío de comentarios (Internos si es true, Públicos si es false)
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
