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
// 1. JIRA WEBHOOK: ALTA REAL EN ADOBE
// ==========================================
expressApp.post('/jira-webhook', async (req, res) => {
  console.log('📬 [WEBHOOK JIRA] ¡He recibido una petición desde Jira!');
  
  try {
    const issue = req.body.issue;
    if (!issue) {
      console.log('⚠️ [WEBHOOK JIRA] El body no contiene un "issue". Petición descartada.');
      return res.status(400).send('No issue data found');
    }

    const ticketKey = issue.key;
    const fields = issue.fields || {};
    const currentStatus = fields.status?.name || '';

    console.log(`🎫 [TICKET] Procesando ${ticketKey} - Estado actual: "${currentStatus}"`);

    const idPadre = fields.customfield_10623?.id || fields.customfield_10623;
    const idHijo = fields.customfield_10620?.id || fields.customfield_10620;
    
    console.log(`🔍 [CAMPOS] Customfield Websites: ${idPadre} | Customfield One.CMS: ${idHijo}`);

    if (currentStatus === 'Request Approved' && idPadre === '12362' && idHijo === '12350') {
      console.log('✅ [FILTRO] El ticket cumple los requisitos de estado, marca y portal. Procediendo a Adobe...');
      
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

      if (marcasAAgregar.length === 0) {
        console.log('⚠️ [ERROR] No se han detectado marcas válidas en el ticket.');
        return res.status(200).send('No valid brands.');
      }

      const gruposAdobeFinales = marcasAAgregar.map(brand => {
        return `SEAT_CUPRA_${paisNombre}_${brand}_Website_${permisoTexto}_IMS`;
      });

      console.log(`👥 [ADOBE] Intentando asignar al usuario ${userEmail} los grupos:`, gruposAdobeFinales);

      // Llamada corregida a la API corporativa de Adobe
      const adobeSuccess = await crearUsuarioEnAdobe(userEmail, gruposAdobeFinales);

      const listaGruposTexto = gruposAdobeFinales.map(g => `\`${g}\``).join(', ');
      let comentarioJira = adobeSuccess 
        ? `🤖 *[Bot]* User provisioning successfully managed in Adobe IMS.\n\n* *User:* ${userEmail}\n* *Assigned Groups:* ${listaGruposTexto}`
        : `⚠️ *[Bot]* Attention IT Team: Auto-provisioning failed in Adobe Admin Console. Please check Render logs.`;
      
      console.log('💬 [JIRA] Añadiendo comentario de resultado al ticket...');
      await añadirComentarioJira(ticketKey, comentarioJira);
      return res.status(200).send('Automation completed.');
    }

    console.log('⏭️ [WEBHOOK JIRA] El ticket no cumple las condiciones de filtrado (Estado != Request Approved o IDs incorrectos).');
    res.status(200).send('Conditions not met.');
  } catch (error) {
    console.error('💥 [ERROR CRÍTICO WEBHOOK]:', error.message);
    res.status(500).send('Error');
  }
});

// ==========================================
// 2. INTERACTIVIDAD SLACK
// ==========================================
slackApp.action('approve_user_adobe', async ({ ack, body, respond }) => {
  await ack(); 
  const userId = body.user.id;
  const ticketKey = body.actions[0].value; 
  const ticketUrl = `https://${process.env.JIRA_DOMAIN}/browse/${ticketKey}`;

  console.log(`🖱️ [SLACK] ¡Botón clicado por <@${userId}> para el ticket ${ticketKey}!`);

  if (ALLOWED_APPROVERS.length > 0 && !ALLOWED_APPROVERS.includes(userId)) {
    console.log(`❌ [SLACK] Acceso denegado. <@${userId}> no está en ALLOWED_APPROVERS.`);
    return await respond({ text: `❌ Sorry, you do not have permission.`, replace_original: false });
  }

  await respond({
    text: `🔄 *Processing approval for <${ticketUrl}|${ticketKey}>...*`,
    replace_original: false
  });

  try {
    console.log(`🔧 [JIRA API] Buscando transiciones para mover ${ticketKey}...`);
    const transUrl = `https://${process.env.JIRA_DOMAIN}/rest/api/3/issue/${ticketKey}/transitions`;
    const resTrans = await axios.get(transUrl, { headers: JIRA_HEADERS });
    
    const foundTransition = resTrans.data.transitions.find(t => t.name.toLowerCase() === 'request approved');

    if (!foundTransition) {
      throw new Error("Transition 'Request Approved' not found or not available from current status.");
    }

    console.log(`🚀 [JIRA API] Ejecutando transición (ID: ${foundTransition.id}) hacia 'Request Approved'...`);
    await axios.post(transUrl, { transition: { id: foundTransition.id } }, { headers: JIRA_HEADERS });

    await respond({
      text: `✅ *Action registered for <${ticketUrl}|${ticketKey}> by <@${userId}>.*\nTicket status successfully moved to *Request Approved* in Jira.`,
      replace_original: false
    });

  } catch (jiraError) {
    console.error('💥 [ERROR SLACK ACTION]:', jiraError.message);
    await respond({
      text: `⚠️ *Approved in Slack, but Jira couldn't update automatically:* ${jiraError.message}`,
      replace_original: false
    });
  }
});

// ==========================================
// API REAL DE ADOBE (CORREGIDA PARA EMOPRESAS)
// ==========================================
async function crearUsuarioEnAdobe(email, grupos) {
  console.log('🔑 [ADOBE] Solicitando Token de acceso a Adobe Authentication...');
  try {
    const tokenUrl = 'https://ims-na1.adobelogin.com/ims/token/v3';
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', process.env.ADOBE_CLIENT_ID);
    params.append('client_secret', process.env.ADOBE_CLIENT_SECRET);
    params.append('scope', 'openid,AdobeID,user_management_sdk');

    const tokenResponse = await axios.post(tokenUrl, params, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const accessToken = tokenResponse.data.access_token;
    console.log('🎫 [ADOBE] Token generado correctamente.');

    const adobeEndpoint = `https://usermanagement.adobe.io/v2/usermanagement/action/${process.env.ADOBE_ORG_ID}`;
    
    // PAYLOAD EMPRESARIAL SEAT: Quitamos createAdobeID para evitar conflictos con Federated/Enterprise IDs
    const adobePayload = [{
      "user": email,
      "do": [
        { "add": { "group": grupos } }
      ]
    }];

    console.log(`📡 [ADOBE] Enviando petición final de alta al Endpoint de Adobe...`);
    const apiResponse = await axios.post(adobeEndpoint, adobePayload, {
      headers: { 'Authorization': `Bearer ${accessToken}`, 'X-Api-Key': process.env.ADOBE_CLIENT_ID, 'Content-Type': 'application/json' }
    });
    
    console.log(`📥 [ADOBE] Respuesta recibida de la API:`, JSON.stringify(apiResponse.data));

    if (apiResponse.data?.completed === 0 && apiResponse.data?.errors?.length > 0) {
      console.error('❌ [ADOBE] La operación devolvió errores específicos:', JSON.stringify(apiResponse.data.errors));
      return false;
    }

    console.log('🎉 [ADOBE] ¡Usuario procesado con éxito en Adobe Console!');
    return true;
  } catch (error) {
    console.error('💥 [ADOBE ERROR SEGUIMIENTO FATAL]:');
    if (error.response) {
      console.error(`- STATUS CODE EN ADOBE: ${error.response.status}`);
      console.error(`- DETALLE ENVIADO POR ADOBE:`, JSON.stringify(error.response.data));
    } else {
      console.error(`- ERROR MENSAJE: ${error.message}`);
    }
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
