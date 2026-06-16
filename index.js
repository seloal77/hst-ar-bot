const { App } = require('@slack/bolt');
const express = require('express');
const axios = require('axios');
require('dotenv').config();

// 1. Inicializar la App de Slack (Para recibir los clics de los botones)
const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: true
});

// 2. Inicializar Express (Servidor web para recibir los Webhooks de Jira)
const expressApp = express();
expressApp.use(express.json());
expressApp.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

// ==========================================
// ESCENARIO 2: APROBACIÓN DESDE SLACK
// ==========================================
// Maneja el clic en el botón "Aprobar" de Slack
slackApp.action('approve_user_adobe', async ({ ack, body, respond }) => {
  await ack(); // Responder a Slack de inmediato para que no dé timeout
  
  const userId = body.user.id; // ID del usuario de Slack que pulsa el botón
  const ticketKey = body.actions[0].value; // Guardamos el ID del ticket de Jira aquí
  const allowedApprovers = process.env.ALLOWED_APPROVERS ? process.env.ALLOWED_APPROVERS.split(',') : [];

  // Validación de seguridad
  if (!allowedApprovers.includes(userId)) {
    await respond({
      text: `❌ <@${userId}>, no tienes permisos para aprobar esta solicitud.`,
      replace_original: false
    });
    return;
  }

  try {
    // Si es aprobador, cambiamos el estado del ticket en Jira a "Request Approved"
    await transicionarTicketJira(ticketKey, "Request Approved");
    
    await respond({
      text: `✅ Solicitud para el ticket *${ticketKey}* aprobada por <@${userId}>. Procesando alta en Adobe...`,
      replace_original: true
    });

    // Nota: Al cambiar el estado en Jira, este disparará el Escenario 1 automáticamente.
  } catch (error) {
    console.error('Error al procesar aprobación de Slack:', error);
  }
});

// ==========================================
// ESCENARIO 1: TRIGGER DESDE JIRA (WEBHOOK)
// ==========================================
// Jira llamará a esta URL cuando un ticket pase a "Request Approved" (ya sea manual por el Solver o vía Slack)
expressApp.post('/jira-webhook', async (req, res) => {
  const issue = req.body.issue;
  
  if (!issue) {
    return res.status(400).send('No issue data found');
  }

  const ticketKey = issue.key;
  const status = issue.fields.status.name;
  
  // Extrae los campos personalizados de tu formulario de Jira (ejemplos)
  const userEmail = issue.fields.customfield_10100; // Cambia por el ID real de tu campo Email
  const tipologia = issue.fields.customfield_10101; // Cambia por el ID real de tu campo Tipología (ej. Adobe CMS)

  if (status === 'Request Approved') {
    console.log(`Disparando alta automática en Adobe para el ticket ${ticketKey}`);
    
    try {
      // AQUÍ SE LLAMA A LA API DE ADOBE ADMIN CONSOLE
      await crearUsuarioEnAdobe(userEmail, tipologia);
      
      // Opcional: Añadir comentario en Jira diciendo que ya está listo
      res.status(200).send('Usuario creado en Adobe con éxito');
    } catch (error) {
      console.error('Error al crear usuario en Adobe:', error);
      res.status(500).send('Error en la API de Adobe');
    }
  } else {
    res.status(200).send('El ticket no está en estado aprobado, no se hace nada.');
  }
});

// Enrutar las peticiones interactivas de Slack a Bolt
expressApp.post('/slack/events', async (req, res) => {
  // Manejador interno para que Slack y Bolt se entiendan mediante Express
  if (req.body.payload) {
    req.body = JSON.parse(req.body.payload);
  }
  // Lógica para procesar con Bolt...
  res.sendStatus(200);
});

// Funciones auxiliares para conectar con las APIs externas
async function transicionarTicketJira(ticketKey, nuevoEstado) {
  // Aquí pondrás tu llamada Axios usando JIRA_DOMAIN, JIRA_EMAIL y JIRA_API_TOKEN
  console.log(`Cambiando estado de ${ticketKey} a ${nuevoEstado} en Jira...`);
}

async function crearUsuarioEnAdobe(email, grupos) {
  // Aquí pondrás la llamada oficial a la API de Adobe Admin Console
  console.log(`Llamando a Adobe API para el email ${email}...`);
}

// Arrancar el servidor global
expressApp.listen(PORT, () => {
  console.log(`Orquestador IT corriendo en el puerto ${PORT}`);
});
