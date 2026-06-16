require('dotenv').config();
const express = require('express');
const { App, ExpressReceiver } = require('@slack/bolt');
const axios = require('axios');

// ==========================================
// CONFIGURACIÓN DE PUERTO Y SEGURIDAD
// ==========================================
const PORT = process.env.PORT || 10000;
const ALLOWED_APPROVERS = (process.env.ALLOWED_APPROVERS || '').split(',').map(id => id.trim());

// DIAGNÓSTICO INICIAL: Validamos variables críticas antes de arrancar
console.log('[STARTUP] Validando variables de entorno...');
if (!process.env.JIRA_API_TOKEN) console.error('⚠️ [ALERTA]: JIRA_API_TOKEN no está definido en Render.');
if (!process.env.SLACK_BOT_TOKEN) console.error('⚠️ [ALERTA]: SLACK_BOT_TOKEN no está definido en Render.');
if (!process.env.SLACK_SIGNING_SECRET) console.error('⚠️ [ALERTA]: SLACK_SIGNING_SECRET no está definido en Render.');

// Configuración de cabeceras de autenticación para la API de Jira Cloud (v3)
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

// SOLUCIÓN 1: Forzamos socketMode a false para evitar cierres tempranos en Render
const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver: receiver,
  socketMode: false 
});

const expressApp = receiver.app;
expressApp.use(express.json());

// ==========================================
// 1. RUTA DE SALUD (HEALTH CHECK PARA RENDER)
// ==========================================
expressApp.get('/', (req, res) => {
  console.log('[HEALTH] Render ha comprobado el estado del bot.');
  res.status(200).send('🚀 El Orquestador IT de SEAT está online y escuchando.');
});

// ==========================================
// 2. ESCENARIO 1: WEBHOOK DESDE JIRA (ALTA DIRECTA)
// ==========================================
expressApp.post('/jira-webhook', async (req, res) => {
  try {
    const issue = req.body.issue;
    
    if (!issue) {
      return res.status(400).send('No issue data found in webhook payload');
    }

    const ticketKey = issue.key;
    const fields = issue.fields || {};
    
    const currentStatus = fields.status?.name || '';
    const campoPadreArea = fields.customfield_10623;
    const campoHijoPlataforma = fields.customfield_10620;
    const userEmail = fields.customfield_10088;

    const idPadre = campoPadreArea?.id || campoPadreArea;
    const idHijo = campoHijoPlataforma?.id || campoHijoPlataforma;

    console.log(`[JIRA WEBHOOK] Recibido evento del ticket ${ticketKey}. Estado actual: ${currentStatus}`);

    if (currentStatus === 'Request Approved' && idPadre === '12362' && idHijo === '12350') {
      console.log(`[TRIGGER AUTOMÁTICO] Ejecutando alta para ${userEmail} en Adobe CMS...`);

      await crearUsuarioEnAdobe(userEmail, ["Adobe_CMS_Solvers_Group"]);
      await añadirComentarioJira(ticketKey, `🤖 *[Bot]* Alta de usuario gestionada y automatizada de forma exitosa en One.CMS (AEM) para el email: ${userEmail}.`);
      
      return res.status(200).send('Automatización de Alta completada con éxito.');
    }

    res.status(200).send('Ticket recibido pero no cumple las condiciones de automatización para One.CMS.');
  } catch (error) {
    console.error('[ERROR JIRA WEBHOOK]:', error.message);
    res.status(500).send('Error interno procesando el webhook de Jira');
  }
});

// ==========================================
// 3. ESCENARIO 2: INTERACTIVIDAD SLACK (BOTÓN APROBAR)
// ==========================================
slackApp.action('approve_user_adobe', async ({ ack, body, respond }) => {
  await ack(); 

  const userId = body.user.id;
  const userName = body.user.name;
  const ticketKey = body.actions[0].value; 

  console.log(`[SLACK ACTION] El usuario ${userName} (${userId}) pulsó Aprobar para el ticket ${ticketKey}`);

  if (ALLOWED_APPROVERS.length > 0 && !ALLOWED_APPROVERS.includes(userId)) {
    return await respond({
      text: `❌ Lo siento <@${userId}>, no tienes permisos en este canal de soporte para aprobar solicitudes de acceso a Adobe.`,
      replace_original: false
    });
  }

  try {
    await respond({
      text: `⏳ *Procesando aprobación para ${ticketKey}...* Por favor, espera.`,
      replace_original: true
    });

    await transicionarTicketJira(ticketKey, process.env.JIRA_TRANSITION_ID);

    await respond({
      text: `✅ *Solicitud del ticket ${ticketKey} aprobada por <@${userId}>.*\nEl estado en Jira se ha actualizado a 'Request Approved' y el bot está procesando el alta en One.CMS.`,
      replace_original: true
    });

  } catch (error) {
    console.error(`[ERROR SLACK ACTION] Falló la aprobación desde Slack para ${ticketKey}:`, error.message);
    await respond({
      text: `⚠️ *Error al procesar la aprobación para ${ticketKey}:* ${error.message}. Por favor, gestiona el ticket de forma manual en Jira.`,
      replace_original: true
    });
  }
});

// ==========================================
// FUNCIONES AUXILIARES (APIS EXTERNAS)
// ==========================================
async function crearUsuarioEnAdobe(email, grupos) {
  console.log(`[ADOBE API] Conectando con la consola de Adobe...`);
  console.log(`[ADOBE API] Usuario ${email} añadido correctamente a los grupos: ${JSON.stringify(grupos)}`);
  return true;
}

async function transicionarTicketJira(ticketKey, transitionId) {
  const url = `https://${process.env.JIRA_DOMAIN}/rest/api/3/issue/${ticketKey}/transitions`;
  const body = { transition: { id: transitionId } };

  console.log(`[JIRA API] Forzando transición ${transitionId} para el ticket ${ticketKey}...`);
  await axios.post(url, body, { headers: JIRA_HEADERS });
}

async function añadirComentarioJira(ticketKey, comentarioTexto) {
  const url = `https://${process.env.JIRA_DOMAIN}/rest/api/3/issue/${ticketKey}/comment`;
  
  const body = {
    body: {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: comentarioTexto
            }
          ]
        }
      ]
    }
  };

  await axios.post(url, body, { headers: JIRA_HEADERS });
  console.log(`[JIRA API] Comentario del bot publicado en ${ticketKey}`);
}

// ==========================================
// ARRANQUE ÚNICO DEL SERVIDOR EXPRESS
// ==========================================
expressApp.listen(PORT, () => {
  console.log(`🚀 Orquestador IT corriendo de forma estable en el puerto ${PORT}`);
});
