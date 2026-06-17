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
  res.status(200).send('🚀 SEAT IT Orchestrator is online.');
});

// ==========================================
// 1. JIRA WEBHOOK: ALTA REAL EN ADOBE (CUANDO PASA A REQUEST APPROVED)
// ==========================================
expressApp.post('/jira-webhook', async (req, res) => {
  try {
    const issue = req.body.issue;
    if (!issue) return res.status(400).send('No issue data found');

    const ticketKey = issue.key;
    const fields = issue.fields || {};
    const currentStatus = fields.status?.name || '';

    const idPadre = fields.customfield_10623?.id || fields.customfield_10623;
    const idHijo = fields.customfield_10620?.id || fields.customfield_10620;

    // FILTRO ANTIBUCLE: Solo actúa si el estado real es 'Request Approved' y es One.CMS
    if (currentStatus === 'Request Approved' && idPadre === '12362' && idHijo === '12350') {
      
      const userEmail = fields.customfield_10088;
      const campoPais = fields.customfield_10257; 
      const campoMarca = fields.customfield_10320; 
      const campoPermiso = fields.customfield_10612;

      const paisNombre = (campoPais?.value || 'GLOBAL').trim();
      const idMarca = campoMarca?.id || campoMarca;
      const idPermiso = campoPermiso?.id || campoPermiso;

      let permisoTexto = 'Preview';
      if (idPermiso === '12322') {
        permisoTexto = 'Editor';
      }

      let marcasAAgregar = [];
      if (idMarca === '11247') marcasAAgregar.push('SEAT');
      if (idMarca === '11248') marcasAAgregar.push('CUPRA');
      if (idMarca === '11249') marcasAAgregar.push('SEAT', 'CUPRA');

      if (marcasAAgregar.length === 0) return res.status(200).send('No valid brands.');

      const gruposAdobeFinales = marcasAAgregar.map(brand => {
        return `SEAT_CUPRA_${paisNombre}_${brand}_Website_${permisoTexto}_IMS`;
      });

      // Llamada real a la API de Adobe
      const adobeSuccess = await crearUsuarioEnAdobe(userEmail, gruposAdobeFinales);

      // Comentario final en inglés en el ticket de Jira
      const listaGruposTexto = gruposAdobeFinales.map(g => `\`${g}\``).join(', ');
      let comentarioJira = adobeSuccess 
        ? `🤖 *[Bot]* User provisioning successfully managed in Adobe IMS.\n\n* *User:* ${userEmail}\n* *Assigned Groups:* ${listaGruposTexto}`
        : `⚠️ *[Bot]* Attention IT Team: Auto-provisioning failed in Adobe Admin Console. Please check Render logs.`;
      
      await añadirComentarioJira(ticketKey, comentarioJira);
      return res.status(200).send('Automation completed.');
    }

    res.status(200).send('Conditions not met.');
  } catch (error) {
    console.error('[ERROR JIRA WEBHOOK]:', error.message);
    res.status(500).send('Error');
  }
});

// ==========================================
// 2. INTERACTIVIDAD SLACK: EL CTA SÓLO CONFIRMA EN PANTALLA
// ==========================================
slackApp.action('approve_user_adobe', async ({ ack, body, respond }) => {
  await ack(); 
  const userId = body.user.id;
  const ticketKey = body.actions[0].value; 
  const ticketUrl = `https://${process.env.JIRA_DOMAIN}/browse/${ticketKey}`;

  if (ALLOWED_APPROVERS.length > 0 && !ALLOWED_APPROVERS.includes(userId)) {
    return await respond({ text: `❌ Sorry, you do not have permission.`, replace_original: false });
  }

  // Como Jira Automation ya movió el ticket a Request Review al nacer,
  // el botón de Slack siempre responderá "OK" al instante sin peligro de error 400.
  await respond({
    text: `✅ *Action registered for <${ticketUrl}|${ticketKey}> by <@${userId}>.*\nProceeding with Adobe IMS matrix provisioning...`,
    replace_original: true
  });
});

// ==========================================
// API REAL DE ADOBE (UMAPI V2 OAUTH)
// ==========================================
async function crearUsuarioEnAdobe(email, grupos) {
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
        { "createAdobeID": { "email": email, "country": "ES" } },
        { "add": { "group": grupos } }
      ]
    }];

    const apiResponse = await axios.post(adobeEndpoint, adobePayload, {
      headers: { 'Authorization': `Bearer ${accessToken}`, 'X-Api-Key': process.env.ADOBE_CLIENT_ID, 'Content-Type': 'application/json' }
    });
    
    return !(apiResponse.data?.completed === 0 && apiResponse.data?.errors?.length > 0);
  } catch (error) {
    console.error(`[ADOBE FATAL]:`, error.message);
    return false;
  }
}

async function añadirComentarioJira(ticketKey, comentarioTexto) {
  const url = `https://${process.env.JIRA_DOMAIN}/rest/api/3/issue/${ticketKey}/comment`;
  const body = {
    body: {
      type: "doc", version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: comentarioTexto }] }]
    }
  };
  await axios.post(url, body, { headers: JIRA_HEADERS });
}

expressApp.listen(PORT, () => {
  console.log(`🚀 IT Orchestrator running stably on port ${PORT}`);
});
