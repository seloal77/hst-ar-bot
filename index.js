require('dotenv').config();
const express = require('express');
const { App, ExpressReceiver } = require('@slack/bolt');
const axios = require('axios');

const PORT = process.env.PORT || 10000;
const ALLOWED_APPROVERS = (process.env.ALLOWED_APPROVERS || '').split(',').map(id => id.trim());

const JIRA_AUTH = Buffer.from(`${process.env.JIRA_EMAIL || ''}:${process.env.JIRA_API_TOKEN || ''}`).toString('base64');
const JIRA_HEADERS = {
  'Authorization': `Basic ${JIRA_AUTH}`,
  'Content-Type': 'application/json'
};

const ticketsProcesadosConExito = new Set();
const ticketsEnProcesoTemporal = new Set();

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
// 1. JIRA WEBHOOK: ALTA EN ADOBE O JIRA
// ==========================================
expressApp.post('/jira-webhook', async (req, res) => {
  const issue = req.body?.issue;
  if (!issue) return res.status(400).send('No issue data found');

  const ticketKey = issue.key;
  const fields = issue.fields || {};
  const currentStatus = fields.status?.name || '';

  if (ticketsProcesadosConExito.has(ticketKey)) {
    console.log(`🛑 [ANTI-DUPLICADO ETERNO] Ticket ${ticketKey} already processed. Ignoring.`);
    return res.status(200).send('Already processed.');
  }

  if (ticketsEnProcesoTemporal.has(ticketKey)) {
    console.log(`🛑 [ANTI-DUPLICADO TEMPORAL] Burst detected for ${ticketKey}. Ignoring.`);
    return res.status(200).send('Duplicate request.');
  }

  const campoAccion = fields.customfield_11728;
  const idAccion = campoAccion?.id || campoAccion;

  if (idAccion === '14665') {
    console.log(`ℹ️ [JIRA WEBHOOK] Ticket ${ticketKey} is 'Delete current account'. Ignoring.`);
    return res.status(200).send('Manual deletion request.');
  }

  const idPadre = String(fields.customfield_10623?.id || fields.customfield_10623 || '');
  const idHijo = String(fields.customfield_10620?.id || fields.customfield_10620 || '');

  const hijosValidosAdobe = ['12350']; 
  const hijosValidosJira = ['12350']; 

  const esAltaAdobeValida = (idPadre === '12362' && hijosValidosAdobe.includes(idHijo));
  const esAltaJiraValida = (idPadre === '12361' && hijosValidosJira.includes(idHijo));

  if (currentStatus === 'Request Approved' && idAccion === '14664' && (esAltaAdobeValida || esAltaJiraValida)) {
    
    // RUTA A: ADOBE (CMS)
    if (esAltaAdobeValida) {
      console.log(`📬 [WEBHOOK JIRA] Processing Adobe provisioning for ${ticketKey}...`);
      ticketsProcesadosConExito.add(ticketKey);
      ticketsEnProcesoTemporal.add(ticketKey);
      res.status(200).send('Processing Adobe started.');

      try {
        const userEmail = fields.customfield_10088;
        let userFirstName = typeof fields.customfield_10189 === 'object' ? (fields.customfield_10189.value || fields.customfield_10189.name || '') : fields.customfield_10189 || '';
        let userLastName = typeof fields.customfield_10190 === 'object' ? (fields.customfield_10190.value || fields.customfield_10190.name || '') : fields.customfield_10190 || '';

        if (!userFirstName.trim() || userFirstName.includes('@')) userFirstName = userEmail.split('@')[0];
        if (!userLastName.trim() || userLastName.includes('@')) userLastName = 'SEAT Corporate';

        const paisNombre = (fields.customfield_10257?.value || 'GLOBAL').trim();
        const idMarca = fields.customfield_10320?.id || fields.customfield_10320;
        const idPermiso = fields.customfield_10612?.id || fields.customfield_10612;

        let permisoTexto = 'Preview';
        if (idPermiso === '12322') permisoTexto = 'Editor';

        let marcasAAgregar = [];
        if (idMarca === '11247') marcasAAgregar.push('SEAT');
        if (idMarca === '11248') marcasAAgregar.push('CUPRA');
        if (idMarca === '11249') marcasAAgregar.push('SEAT', 'CUPRA');

        if (marcasAAgregar.length === 0) return console.log('⚠️ No brands detected.');

        const gruposAdobeFinales = marcasAAgregar.map(brand => `SEAT_CUPRA_${paisNombre}_${brand}_Website_${permisoTexto}_IMS`);
        const resultadoAdobe = await crearUsuarioEnAdobe(userEmail, userFirstName.trim(), userLastName.trim(), gruposAdobeFinales);

        let comentarioJira = '';
        if (resultadoAdobe.success) {
          const listaGruposTexto = gruposAdobeFinales.map(g => `\`${g}\``).join(', ');
          comentarioJira = `🤖 *[HST Access SyncBot]* User created successfully in Adobe IMS.\n\n- User: ${userEmail}\n- Name: ${userFirstName} ${userLastName}\n- Assigned Groups: ${listaGruposTexto}`;
        } else {
          // CORRECCIÓN PUNTO 2: Comentario limpio, sin código feo de Adobe y 100% en inglés
          const errorMsg = resultadoAdobe.errorReason || '';
          let diagnosticoSoporte = '';

          if (errorMsg.includes("createFederatedID")) {
            diagnosticoSoporte = `⚠️ *[HST Access SyncBot]* Auto-provisioning failed in Adobe Admin Console.\n\n📌 *IT Diagnostic:* This user's email domain has corporate directory synchronization enabled. To complete this request, an administrator must log into the *Adobe Admin Console*, locate the directory for this domain, and manually check the option *'Enable editing for 1 hour'* before re-triggering this transition.`;
          } else if (errorMsg.includes("401") || errorMsg.includes("unauthorized") || errorMsg.includes("JWT")) {
            diagnosticoSoporte = `⚠️ *[HST Access SyncBot]* Auto-provisioning failed in Adobe Admin Console.\n\n📌 *IT Diagnostic:* Bot authentication error. The Adobe API credentials assigned in Render environment variables have expired or are incorrect. Please verify the Client Secret.`;
          } else if (errorMsg.includes("country")) {
            diagnosticoSoporte = `⚠️ *[HST Access SyncBot]* Auto-provisioning failed in Adobe Admin Console.\n\n📌 *IT Diagnostic:* The country code provided is not supported by SEAT's Adobe Console. Please check the Market field in the Jira form.`;
          } else {
            diagnosticoSoporte = `⚠️ *[HST Access SyncBot]* Auto-provisioning failed in Adobe Admin Console.\n\n📌 *IT Diagnostic:* General error returned by Adobe endpoint: \`${errorMsg}\`.`;
          }

          comentarioJira = diagnosticoSoporte;
        }
        await añadirComentarioJira(ticketKey, comentarioCompleto(comentarioJira));
      } catch (err) { console.error('💥 Adobe route error:', err.message); }
      finally { setTimeout(() => ticketsEnProcesoTemporal.delete(ticketKey), 10000); }
    }

    // RUTA B: JIRA (HOLA SUPPORT)
    else if (esAltaJiraValida) {
      console.log(`📬 [WEBHOOK JIRA] Processing Jira provisioning for ${ticketKey}...`);
      ticketsProcesadosConExito.add(ticketKey);
      ticketsEnProcesoTemporal.add(ticketKey);
      res.status(200).send('Processing Jira started.');

      try {
        const accountIdUser = issue.fields?.reporter?.accountId;
        const userEmail = fields.customfield_10088 || issue.fields?.reporter?.emailAddress || 'unknown';

        if (!accountIdUser) {
          await añadirComentarioJira(ticketKey, comentarioCompleto(`⚠️ *[HST Access SyncBot]* Error: Could not locate Jira accountId for group assignment.`));
          return;
        }

        const gruposJira = ['f72d3948-1297-4126-be44-0cf5d895d13f', '23b4e346-471b-4144-a24b-49740dc23657'];
        let erroresGrupos = [];

        for (const grupo of gruposJira) {
          const resGrupo = await añadirUsuarioAGrupoJira(accountIdUser, grupo);
          if (!resGrupo.success) erroresGrupos.push(`${grupo} (${resGrupo.errorReason})`);
        }

        let comentarioJira = '';
        if (erroresGrupos.length === 0) {
          comentarioJira = `🤖 *[HST Access SyncBot]* User licensed and provisioned successfully in Jira Cloud.\n\n- User: ${userEmail}\n- Role: Customer (Non-Agent)\n- Assigned Groups: ${gruposJira.map(g => `\`${g}\``).join(', ')}`;
        } else {
          comentarioJira = `⚠️ *[HST Access SyncBot]* Provisioning partial failure in Jira Groups.\n\n- Failed Groups: ${erroresGrupos.join(', ')}`;
        }
        await añadirComentarioJira(ticketKey, comentarioCompleto(comentarioJira));
      } catch (err) { console.error('💥 Jira route error:', err.message); }
      finally { setTimeout(() => ticketsEnProcesoTemporal.delete(ticketKey), 10000); }
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
    console.log(`🔍 [SLACK ACTION] Fetching issue details for ${ticketKey}...`);
    const ticketRes = await axios.get(`https://${process.env.JIRA_DOMAIN}/rest/api/3/issue/${ticketKey}`, { headers: JIRA_HEADERS });
    const fields = ticketRes.data?.fields || {};

    const idPadre = String(fields.customfield_10623?.id || fields.customfield_10623 || '');
    
    const cabeceraPlataforma = idPadre === '12361' 
      ? 'New access request for HOLA Support' 
      : 'New access request for One.CMS (AEM)';

    let userFirstName = typeof fields.customfield_10189 === 'object' ? (fields.customfield_10189.value || fields.customfield_10189.name || '') : fields.customfield_10189 || '';
    let userLastName = typeof fields.customfield_10190 === 'object' ? (fields.customfield_10190.value || fields.customfield_10190.name || '') : fields.customfield_10190 || '';

    if (!userFirstName.trim()) userFirstName = userEmailDetectado.split('@')[0];
    if (!userLastName.trim()) userLastName = 'SEAT Corporate';

    const mercado = (fields.customfield_10257?.value || 'GLOBAL').trim();
    const permisoOriginal = (fields.customfield_10612?.value || fields.customfield_10612 || 'Preview').trim();

    let permisoSlack = permisoOriginal;
    if (permisoOriginal.toLowerCase() === 'editor') permisoSlack = 'Edition (+preview)';
    if (idPadre === '12361') permisoSlack = 'Customer standard access';

    // Transicionamos el ticket en Jira
    const transUrl = `https://${process.env.JIRA_DOMAIN}/rest/api/3/issue/${ticketKey}/transitions`;
    const resTrans = await axios.get(transUrl, { headers: JIRA_HEADERS });
    const foundTransition = resTrans.data.transitions.find(t => t.name.toLowerCase() === 'request approved');
    
    if (!foundTransition) throw new Error("Transition 'Request Approved' not found.");
    await axios.post(transUrl, { transition: { id: foundTransition.id } }, { headers: JIRA_HEADERS });

    // CORRECCIÓN PUNTO 1: Mensaje honesto en Slack. Informamos de que el ticket cambió a 'Approved' y se está ejecutando la acción.
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
// API AUXILIAR: ALTA EN GRUPOS DE JIRA
// ==========================================
async function añadirUsuarioAGrupoJira(accountId, grupoNombre) {
  try {
    const url = `https://${process.env.JIRA_DOMAIN}/rest/api/3/group/user?groupname=${encodeURIComponent(grupoNombre)}`;
    const response = await axios.post(url, { accountId: accountId }, { headers: JIRA_HEADERS });
    if (response.status === 201 || response.status === 200) return { success: true };
    return { success: false, errorReason: `Status ${response.status}` };
  } catch (error) {
    let msg = error.message;
    if (error.response && error.response.data) msg = typeof error.response.data === 'object' ? JSON.stringify(error.response.data) : error.response.data;
    return { success: false, errorReason: msg };
  }
}

// ==========================================
// API AUXILIAR: ALTA EN GRUPOS DE ADOBE
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

async function añadirComentarioJira(ticketKey, bodyContent) {
  const url = `https://${process.env.JIRA_DOMAIN}/rest/api/3/issue/${ticketKey}/comment`;
  const payloadInterno = { ...bodyContent, properties: [{ key: "sd.public.comment", value: { internal: true } }] };
  await axios.post(url, payloadInterno, { headers: JIRA_HEADERS });
}

function comentarioCompleto(texto) {
  return { body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: texto }] }] } };
}

expressApp.listen(PORT, () => {
  console.log(`🚀 HST Access SyncBot running stably on port ${PORT}`);
});
