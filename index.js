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

// Sistema de memoria temporal para bloquear duplicados y ráfagas concurrentes de Jira
const ticketsEnProceso = new Set();

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
  const issue = req.body?.issue;
  if (!issue) return res.status(400).send('No issue data found');

  const ticketKey = issue.key;
  const fields = issue.fields || {};
  const currentStatus = fields.status?.name || '';

  // Control estricto de duplicados en ráfaga
  if (ticketsEnProceso.has(ticketKey)) {
    console.log(`🛑 [ANTI-DUPLICADO] El ticket ${ticketKey} ya se está procesando. Ignorando ráfaga duplicada.`);
    return res.status(200).send('Duplicate request ignored.');
  }

  const idPadre = fields.customfield_10623?.id || fields.customfield_10623;
  const idHijo = fields.customfield_10620?.id || fields.customfield_10620;

  if (currentStatus === 'Request Approved' && idPadre === '12362' && idHijo === '12350') {
    console.log(`📬 [WEBHOOK JIRA] ¡Petición válida recibida para ${ticketKey}! Activando bloqueo...`);
    ticketsEnProceso.add(ticketKey);

    // Respondemos rápido a Jira con un 200 para mitigar el ansia de sus reintentos
    res.status(200).send('Processing started.');

    try {
      const userEmail = fields.customfield_10088;
      
      const userFirstName = (fields.customfield_10189 || 'SEAT').trim();
      const userLastName = (fields.customfield_10190 || 'User').trim();

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
        ticketsEnProceso.delete(ticketKey);
        return;
      }

      const gruposAdobeFinales = marcasAAgregar.map(brand => {
        return `SEAT_CUPRA_${paisNombre}_${brand}_Website_${permisoTexto}_IMS`;
      });

      console.log(`👥 [ADOBE] Intentando asignar al usuario ${userEmail} los grupos:`, gruposAdobeFinales);

      // La función ahora devuelve un objeto con el estado y el mensaje de error si lo hubiera
      const resultadoAdobe = await crearUsuarioEnAdobe(userEmail, userFirstName, userLastName, gruposAdobeFinales);

      let comentarioJira = '';
      if (resultadoAdobe.success) {
        const listaGruposTexto = gruposAdobeFinales.map(g => `\`${g}\``).join(', ');
        comentarioJira = `🤖 *[Bot]* User provisioning successfully managed in Adobe IMS.\n\n* *User:* ${userEmail}\n* *Name:* ${userFirstName} ${userLastName}\n* *Assigned Groups:* ${listaGruposTexto}`;
      } else {
        // MEJORA: Pasamos el error real directo al comentario de Jira
        comentarioJira = `⚠️ *[Bot]* Auto-provisioning failed in Adobe Admin Console.\n\n* *Reason:* ${resultadoAdobe.errorReason}`;
      }
      
      console.log('💬 [JIRA] Añadiendo el comentario definitivo al ticket...');
      await añadirComentarioJira(ticketKey, comentarioCompleto(comentarioJira));

    } catch (error) {
      console.error('💥 [ERROR CRÍTICO WEBHOOK]:', error.message);
    } finally {
      // Mantenemos el ticket bloqueado en memoria 10 segundos enteros para destruir cualquier ráfaga rezagada de Jira
      setTimeout(() => {
        ticketsEnProceso.delete(ticketKey);
        console.log(`🔓 [ANTI-DUPLICADO] El ticket ${ticketKey} ha sido desbloqueado de forma segura.`);
      }, 10000);
    }
  } else {
    res.status(200).send('Conditions not met.');
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
// API REAL DE ADOBE (RETORNA STATUS + ERROR)
// ==========================================
async function crearUsuarioEnAdobe(email, firstName, lastName, grupos) {
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
    
    const adobePayload = [{
      "user": email,
      "do": [
        { 
          "createFederatedID": {
            "email": email,
            "country": "ES",
            "firstname": firstName,
            "lastname": lastName
          } 
        },
        { 
          "add": { 
            "group": grupos 
          } 
        }
      ]
    }];

    console.log(`📡 [ADOBE] Enviando petición final de alta al Endpoint de Adobe...`);
    const apiResponse = await axios.post(adobeEndpoint, adobePayload, {
      headers: { 'Authorization': `Bearer ${accessToken}`, 'X-Api-Key': process.env.ADOBE_CLIENT_ID, 'Content-Type': 'application/json' }
    });
    
    console.log(`📥 [ADOBE] Respuesta recibida de la API:`, JSON.stringify(apiResponse.data));

    if (apiResponse.data?.completed === 0 && apiResponse.data?.errors?.length > 0) {
      const errorDetalle = apiResponse.data.errors[0];
      
      // El bypass de usuario existente se mantiene como un OK legítimo
      if (errorDetalle.errorCode === "error.user.already_in_org") {
        console.log('ℹ️ [ADOBE SUCCESS BYPASS] El usuario ya existía, pero los grupos se asociaron correctamente.');
        return { success: true };
      }
      
      console.error('❌ [ADOBE] Error reportado por Adobe:', errorDetalle.message);
      return { success: false, errorReason: errorDetalle.message };
    }

    console.log('🎉 [ADOBE] ¡Usuario procesado con éxito en la consola Federated de Adobe!');
    return { success: true };
  } catch (error) {
    console.error('💥 [ADOBE ERROR SEGUIMIENTO FATAL]:');
    let msg = error.message;
    if (error.response && error.response.data) {
      msg = JSON.stringify(error.response.data);
    }
    return { success: false, errorReason: msg };
  }
}

async function añadirComentarioJira(ticketKey, bodyContent) {
  const url = `https://${process.env.JIRA_DOMAIN}/rest/api/3/issue/${ticketKey}/comment`;
  await axios.post(url, bodyContent, { headers: JIRA_HEADERS });
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
  console.log(`🚀 IT Orchestrator running stably on port ${PORT}`);
});
