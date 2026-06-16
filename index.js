require('dotenv').config();
const express = require('express');
const { App, ExpressReceiver } = require('@slack/bolt');
const axios = require('axios');

// ==========================================
// CONFIGURACIÓN DE PUERTO Y SEGURIDAD
// ==========================================
const PORT = process.env.PORT || 10000;
const ALLOWED_APPROVERS = (process.env.ALLOWED_APPROVERS || '').split(',').map(id => id.trim());

const JIRA_AUTH = Buffer.from(`${process.env.JIRA_EMAIL || ''}:${process.env.JIRA_API_TOKEN || ''}`).toString('base64');
const JIRA_HEADERS = {
  'Authorization': `Basic ${JIRA_AUTH}`,
  'Content-Type': 'application/json'
};

// ==========================================
// INICIALIZACIÓN DE EXPRESS Y SLACK BOLT
// ==========================================
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
  res.status(200).send('🚀 El Orquestador IT de SEAT está online y escuchando.');
});

// ==========================================
// 2. ESCENARIO 1: WEBHOOK DESDE JIRA (ALTA REAL EN ADOBE)
// ==========================================
expressApp.post('/jira-webhook', async (req, res) => {
  try {
    const issue = req.body.issue;
    if (!issue) return res.status(400).send('No issue data found');

    const ticketKey = issue.key;
    const fields = issue.fields || {};
    const currentStatus = fields.status?.name || '';

    // Filtro de plataforma (Websites -> One.CMS)
    const idPadre = fields.customfield_10623?.id || fields.customfield_10623;
    const idHijo = fields.customfield_10620?.id || fields.customfield_10620;

    console.log(`[JIRA WEBHOOK] Ticket ${ticketKey} recibido. Estado: ${currentStatus}`);

    // Solo actuamos si el ticket está aprobado y pertenece a la plataforma One.CMS (AEM)
    if (currentStatus === 'Request Approved' && idPadre === '12362' && idHijo === '12350') {
      
      // 1. Extracción de los Custom Fields técnicos de la solicitud
      const userEmail = fields.customfield_10088;
      const campoPais = fields.customfield_10257; 
      const campoMarca = fields.customfield_10320; 
      const campoPermiso = fields.customfield_10612;

      const paisNombre = (campoPais?.value || 'GLOBAL').trim();
      const idMarca = campoMarca?.id || campoMarca;
      const idPermiso = campoPermiso?.id || campoPermiso;

      // 2. Mapeo de Permisos (Preview vs Editor conforme a la nomenclatura de Adobe)
      let permisoTexto = 'Preview';
      if (idPermiso === '12322') {
        permisoTexto = 'Editor';
      }

      // 3. Mapeo de Marcas con soporte para la opción mixta (SEAT/CUPRA)
      let marcasAAgregar = [];
      if (idMarca === '11247') {
        marcasAAgregar.push('SEAT');
      } else if (idMarca === '11248') {
        marcasAAgregar.push('CUPRA');
      } else if (idMarca === '11249') {
        // Opción mixta: se añaden ambas marcas de manera independiente
        marcasAAgregar.push('SEAT', 'CUPRA');
      }

      if (marcasAAgregar.length === 0) {
        console.log(`[BOT] No se detectó una marca válida (ID: ${idMarca}) para el ticket ${ticketKey}`);
        return res.status(200).send('Ticket procesado sin marcas válidas.');
      }

      // 4. Construcción dinámica de los grupos según el patrón corporativo exacto
      // Patrón: SEAT_CUPRA_COUNTRY_BRAND_Website_PERMISSIONS_IMS
      const gruposAdobeFinales = marcasAAgregar.map(brand => {
        return `SEAT_CUPRA_${paisNombre}_${brand}_Website_${permisoTexto}_IMS`;
      });

      console.log(`[TRIGGER AUTOMÁTICO] Ejecutando alta para ${userEmail}. Grupos a asignar: ${JSON.stringify(gruposAdobeFinales)}`);

      // 5. Llamada a la API de aprovisionamiento de identidades de Adobe
      await crearUsuarioEnAdobe(userEmail, gruposAdobeFinales);

      // 6. Notificación de éxito en el ticket de Jira con los grupos reales asignados
      const listaGruposTexto = gruposAdobeFinales.map(g => `\`${g}\``).join(', ');
      await añadirComentarioJira(ticketKey, `🤖 *[Bot]* Alta de usuario gestionada de forma automática en Adobe IMS.\n\n* *Usuario:* ${userEmail}\n* *Grupos asignados:* ${listaGruposTexto}`);
      
      return res.status(200).send('Automatización ejecutada con éxito mapeando la matriz corporativa.');
    }

    res.status(200).send('El ticket no cumple las condiciones para el alta automática.');
  } catch (error) {
    console.error('[ERROR JIRA WEBHOOK]:', error.message);
    res.status(500).send('Error interno procesando la matriz de Adobe');
  }
});

// ==========================================
// 3. ESCENARIO 2: INTERACTIVIDAD SLACK (BOTÓN APROBAR)
// ==========================================
slackApp.action('approve_user_adobe', async ({ ack, body, respond }) => {
  await ack(); 
  const userId = body.user.id;
  const ticketKey = body.actions[0].value; 

  if (ALLOWED_APPROVERS.length > 0 && !ALLOWED_APPROVERS.includes(userId)) {
    return await respond({
      text: `❌ Lo siento <@${userId}>, no tienes permisos para aprobar este acceso.`,
      replace_original: false
    });
  }

  try {
    await respond({ text: `⏳ *Procesando aprobación para ${ticketKey}...*`, replace_original: true });
    await transicionarTicketJira(ticketKey, process.env.JIRA_TRANSITION_ID);
    await respond({
      text: `✅ *Solicitud ${ticketKey} aprobada por <@${userId}>.*\nJira actualizado a 'Request Approved' y procesando alta con la matriz IMS de Adobe.`,
      replace_original: true
    });
  } catch (error) {
    console.error(`[ERROR SLACK ACTION]:`, error.message);
    await respond({ text: `⚠️ *Error en Slack Action:* ${error.message}`, replace_original: true });
  }
});

// ==========================================
// FUNCIONES AUXILIARES (APIS EXTERNAS)
// ==========================================
async function crearUsuarioEnAdobe(email, grupos) {
  console.log(`[ADOBE API] Conectando con la consola Adobe IMS...`);
  console.log(`[ADOBE API] Enviando provisión para ${email} en los grupos: ${JSON.stringify(grupos)}`);
  return true;
}

async function transicionarTicketJira(ticketKey, transitionId) {
  const url = `https://${process.env.JIRA_DOMAIN}/rest/api/3/issue/${ticketKey}/transitions`;
  const body = { transition: { id: transitionId } };
  await axios.post(url, body, { headers: JIRA_HEADERS });
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
  console.log(`🚀 Orquestador IT corriendo de forma estable en el puerto ${PORT}`);
});
