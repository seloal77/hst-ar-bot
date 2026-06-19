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

// Registro de memoria permanente y temporal contra duplicados de Jira
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

  if (ticketsProcesadosConExito.has(ticketKey)) {
    console.log(`🛑 [ANTI-DUPLICADO ETERNO] El ticket ${ticketKey} ya fue procesado con éxito. Ignorando.`);
    return res.status(200).send('Already processed in the past.');
  }

  if (ticketsEnProcesoTemporal.has(ticketKey)) {
    console.log(`🛑 [ANTI-DUPLICADO TEMPORAL] Ráfaga detectada para ${ticketKey}. Ignorando.`);
    return res.status(200).send('Duplicate request ignored.');
  }

  const idPadre = fields.customfield_10623?.id || fields.customfield_10623;
  const idHijo = fields.customfield_10620?.id || fields.customfield_10620;

  if (currentStatus === 'Request Approved' && idPadre === '12362' && idHijo === '12350') {
    console.log(`📬 [WEBHOOK JIRA] ¡Petición válida recibida para ${ticketKey}! Activando bloqueos...`);
    ticketsEnProcesoTemporal.add(ticketKey);

    res.status(200).send('Processing started.');

    try {
      const userEmail = fields.customfield_10088;
      
      let userFirstName = '';
      let userLastName = '';

      if (fields.customfield_10189) {
        userFirstName = typeof fields.customfield_10189 === 'object' 
          ? (fields.customfield_10189.value || fields.customfield_10189.name || '') 
          : fields.customfield_10189;
      }
      
      if (fields.customfield_10190) {
        userLastName = typeof fields.customfield_10190 === 'object' 
          ? (fields.customfield_10190.value || fields.customfield_10190.name || '') 
          : fields.customfield_10190;
      }

      if (!userFirstName.trim() || userFirstName.includes('@')) {
        userFirstName = userEmail.split('@')[0];
      }
      if (!userLastName.trim() || userLastName.includes('@')) {
        userLastName = 'SEAT Corporate';
      }

      userFirstName = userFirstName.trim();
      userLastName = userLastName.trim();

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
        ticketsEnProcesoTemporal.delete(ticketKey);
        return;
      }

      const gruposAdobeFinales = marcasAAgregar.map(brand => {
        return `SEAT_CUPRA_${paisNombre}_${brand}_Website_${permisoTexto}_IMS`;
      });

      console.log(`👥 [ADOBE] Intentando asignar al usuario ${userEmail} los grupos:`, gruposAdobeFinales);

      const resultadoAdobe = await crearUsuarioEnAdobe(userEmail, userFirstName, userLastName, gruposAdobeFinales);

      let comentarioJira = '';
      if (resultadoAdobe.success) {
        const listaGruposTexto = gruposAdobeFinales.map(g => `\`${g}\``).join(', ');
        comentarioJira = `🤖 *[Bot]* User created successfully in Adobe IMS.\n\n- User: ${userEmail}\n- Name: ${userFirstName} ${userLastName}\n- Assigned Groups: ${listaGruposTexto}`;
        ticketsProcesadosConExito.add(ticketKey);
      } else {
        comentarioJira = `⚠️ *[Bot]* Auto-provisioning failed in Adobe Admin Console.\n\n- Reason: ${resultadoAdobe.errorReason}`;
      }
      
      console.log('💬 [JIRA] Añadiendo el comentario definitivo interno al ticket...');
      await añadirComentarioJira(ticketKey, comentarioCompleto(comentarioJira));

    } catch (error) {
      console.error('💥 [ERROR CRÍTICO WEBHOOK]:', error.message);
    } finally {
      setTimeout(() => {
        ticketsEnProcesoTemporal.delete(ticketKey);
        console.log(`🔓 [ANTI-DUPLICADO] El candado de ráfaga para ${ticketKey} ha expirado.`);
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

  // Desvanecimiento rápido de botones manteniendo cabecera original
  await ack({
    text: `🚨 *New access request for One.CMS (AEM)*\n• *Ticket:* <${ticketUrl}|${ticketKey}>\n• *User:* ${userEmailDetectado}\n\n🔄 _Processing approval (Requested by <@${userId}>)..._`,
    replace_original: true
  });

  try {
    console.log(`🔍 [SLACK ACTION] Consultando detalles de ${ticketKey} en Jira...`);
    const ticketRes = await axios.get(`https://${process.env.JIRA_DOMAIN}/rest/api/3/issue/${ticketKey}`, { headers: JIRA_HEADERS });
    const fields = ticketRes.data?.fields || {};

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
    const permisoOriginal = (fields.customfield_10612?.value || 'Preview').trim();

    let permisoSlack = 'Preview';
    if (permisoOriginal.toLowerCase() === 'editor') {
      permisoSlack = 'Edition (+preview)';
    }

    const transUrl = `https://${process.env.JIRA_DOMAIN}/rest/api/3/issue/${ticketKey}/transitions`;
    const resTrans = await axios.get(transUrl, { headers: JIRA_HEADERS });
    
    const foundTransition = resTrans.data.transitions.find(t => t.name.toLowerCase() === 'request approved');
    if (!foundTransition) {
      throw new Error("Transition 'Request Approved' not found.");
    }

    await axios.post(transUrl, { transition: { id: foundTransition.id } }, { headers: JIRA_HEADERS });

    // Respuesta editada con la maqueta final que solicitaste
    await respond({
      text: `🚨 *New access request for One.CMS (AEM)*\n• *Ticket:* <${ticketUrl}|${ticketKey}>\n• *User:* ${userEmailDetectado}\n\n Approved and processed successfully.\nAction executed by <@${userId}>. Status moved to *Request Approved*.\n\n*User Profile managed:*\n- Name: ${userFirstName.trim()} ${userLastName.trim()}\n- Market: ${mercado}\n- Permission: ${permisoSlack}`,
      replace_original: true
    });

  } catch (jiraError) {
    console.error('💥 [ERROR SLACK ACTION]:', jiraError.message);
    await respond({
      text: `🚨 *New access request for One.CMS (AEM)*\n• *Ticket:* <${ticketUrl}|${ticketKey}>\n• *User:* ${userEmailDetectado}\n\n⚠️ *Slack action registered, but Jira update encountered an issue:* ${jiraError.message}`,
      replace_original: true
    });
  }
});

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

    const apiResponse = await axios.post(adobeEndpoint, adobePayload, {
      headers: { 'Authorization': `Bearer ${accessToken}`, 'X-Api-Key': process.env.ADOBE_CLIENT_ID, 'Content-Type': 'application/json' }
    });

    if (apiResponse.data?.completed === 0 && apiResponse.data?.errors?.length > 0) {
      const errorDetalle = apiResponse.data.errors[0];
      if (errorDetalle.errorCode === "error.user.already_in_org") {
        return { success: true };
      }
      return { success: false, errorReason: errorDetalle.message };
    }

    return { success: true };
  } catch (error) {
    let msg = error.message;
    if (error.response && error.response.data) msg = JSON.stringify(error.response.data);
    return { success: false, errorReason: msg };
  }
}

// Envío forzado de comentario interno en Jira Service Management
async function añadirComentarioJira(ticketKey, bodyContent) {
  const url = `https://${process.env.JIRA_DOMAIN}/rest/api/3/issue/${ticketKey}/comment`;
  
  const payloadInterno = {
    ...bodyContent,
    properties: [
      {
        key: "sd.public.comment",
        value: {
          internal: true
        }
      }
    ]
  };

  await axios.post(url, payloadInterno, { headers: JIRA_HEADERS });
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
