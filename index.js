require('dotenv').config();
const express = require('express');
const { App, ExpressReceiver } = require('@slack/bolt');
const axios = require('axios');

// ==========================================
// CONFIGURACIÓN DE PUERTO Y SEGURIDAD
// ==========================================
const PORT = process.env.PORT || 10000;
const ALLOWED_APPROVERS = (process.env.ALLOWED_APPROVERS || '').split(',').map(id => id.trim());

// Configuración de cabeceras de autenticación para la API de Jira Cloud (v3)
const JIRA_AUTH = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
const JIRA_HEADERS = {
  'Authorization': `Basic ${JIRA_AUTH}`,
  'Content-Type': 'application/json'
};

// ==========================================
// INICIALIZACIÓN DE EXPRESS Y SLACK BOLT
// ==========================================
// Usamos ExpressReceiver para que Slack y nuestros Webhooks compartan el mismo puerto de Render
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: true
});

const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver: receiver
});

const expressApp = receiver.app;
expressApp.use(express.json());

// ==========================================
// 1. RUTA DE SALUD (HEALTH CHECK PARA RENDER)
// ==========================================
// Esta ruta responde a Render que el bot está vivo y evita el error "Application exited early"
expressApp.get('/', (req, res) => {
  console.log('[HEALTH] Render ha comprobado el estado del bot.');
  res.status(200).send('🚀 El Orquestador IT de SEAT está online y escuchando.');
});

// ==========================================
// 2. ESCENARIO 1: WEBHOOK DESDE JIRA (APROBACIÓN MANUAL O TRAS BOTÓN)
// ==========================================
// Se dispara cuando el ticket se mueve al estado "Request Approved" (ID de transición)
expressApp.post('/jira-webhook', async (req, res) => {
  try {
    const issue = req.body.issue;
    
    if (!issue) {
      return res.status(400).send('No issue data found in webhook payload');
    }

    const ticketKey = issue.key;
    const fields = issue.fields || {};
    
    // Extraemos el estado actual del ticket
    const currentStatus = fields.status?.name || '';
    
    // Extraemos los campos del formulario de Jira (Padre, Hijo y Email)
    const campoPadreArea = fields.customfield_10623;
    const campoHijoPlataforma = fields.customfield_10620;
    const userEmail = fields.customfield_10088;

    const idPadre = campoPadreArea?.id || campoPadreArea;
    const idHijo = campoHijoPlataforma?.id || campoHijoPlataforma;

    console.log(`[JIRA WEBHOOK] Recibido evento del ticket ${ticketKey}. Estado actual: ${currentStatus}`);

    // Filtro estricto: Solo actuamos si el ticket está en "Request Approved" y es One.CMS (Websites -> One.CMS)
    if (currentStatus === 'Request Approved' && idPadre === '12362' && idHijo === '12350') {
      console.log(`[TRIGGER AUTOMÁTICO] Ejecutando alta para ${userEmail} en Adobe CMS...`);

      // 1. Ejecutar llamada a la API de Adobe para crear el usuario
      await crearUsuarioEnAdobe(userEmail, ["Adobe_CMS_Solvers_Group"]);

      // 2. Añadir un comentario de éxito en el ticket de Jira
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
// Se ejecuta cuando un aprobador pulsa el botón en el canal de Slack
slackApp.action('approve_user_adobe', async ({ ack, body, respond }) => {
  await ack(); // Le avisa a Slack de inmediato que hemos recibido el clic

  const userId = body.user.id;
  const userName = body.user.name;
  const ticketKey = body.actions[0].value; // Recuperamos el ID del ticket que inyectó Jira Automation

  console.log(`[SLACK ACTION] El usuario ${userName} (${userId}) pulsó Aprobar para el ticket ${ticketKey}`);

  // Control de Seguridad: Validamos si el usuario de Slack está autorizado
  if (ALLOWED_APPROVERS.length > 0 && !ALLOWED_APPROVERS.includes(userId)) {
    return await respond({
      text: `❌ Lo siento <@${userId}>, no tienes permisos en este canal de soporte para aprobar solicitudes de acceso a Adobe.`,
      replace_original: false
    });
  }

  try {
    // 1. Notificar en el canal de Slack que la petición está en proceso
    await respond({
      text: `⏳ *Procesando aprobación para ${ticketKey}...* Por favor, espera.`,
      replace_original: true
    });

    // 2. Hacer la llamada a la API de Jira para transicionar el estado del ticket a "Request Approved"
    // Esto provocará que Jira cambie el estado y, de rebote, disparará el Escenario 1 para el alta automática
    await transicionarTicketJira(ticketKey, process.env.JIRA
