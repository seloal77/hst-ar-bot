const { App } = require('@slack/bolt');
const express = require('express');
const axios = require('axios');
require('dotenv').config();

// 1. Inicializar la App de Slack utilizando tus Variables de Entorno de Render
const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: true
});

// 2. Inicializar Express para recibir los Webhooks de Jira
const expressApp = express();
expressApp.use(express.json());
expressApp.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

// Configuración de cabeceras de autenticación para la API de Jira Cloud (v3)
const JIRA_AUTH = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
const JIRA_HEADERS = {
  'Authorization': `Basic ${JIRA_AUTH}`,
  'Content-Type': 'application/json'
};

// =========================================================================
// ESCENARIO 2: INTERACCIÓN Y VALIDACIÓN DESDE EL CANAL DE SLACK
// =========================================================================
// Maneja la acción del botón "Aprobar" cuando se pulsa en el canal de Slack
slackApp.action('approve_user_adobe', async ({ ack, body, respond }) => {
  await ack(); // Respuesta inmediata a Slack para evitar el timeout de 3 segundos
  
  const userId = body.user.id; // ID del usuario de Slack que interactúa (U...)
  const ticketKey = body.actions[0].value; // Recuperamos la clave del ticket (ej: SDC-123)
  const allowedApprovers = process.env.ALLOWED_APPROVERS ? process.env.ALLOWED_APPROVERS.split(',') : [];

  // Verificación de seguridad: ¿Está el usuario en la lista de ALLOWED_APPROVERS?
  if (!allowedApprovers.includes(userId)) {
    await respond({
      text: `❌ <@${userId}>, no tienes permisos de negocio asignados para aprobar esta solicitud.`,
      replace_original: false // No borra el mensaje original con los botones para los demás
    });
    return;
  }

  try {
    // Recuperamos el ID de la transición desde tu variable de entorno en Render (ej: 21)
    const transitionId = process.env.JIRA_TRANSITION_ID || "21";
    
    // Forzamos el cambio de estado en Jira a través de su API REST
    await transicionarTicketJira(ticketKey, transitionId);
    
    // Actualizamos el mensaje de Slack notificando el éxito de la aprobación
    await respond({
      text: `✅ Solicitud del ticket *${ticketKey}* aprobada por <@${userId}>. Sincronizando estado en Jira y lanzando alta en Adobe...`,
      replace_original: true // Reemplaza el bloque de botones para evitar dobles clics
    });
  } catch (error) {
    console.error('Error al procesar la transición desde Slack:', error.message);
    await respond({
      text: `❌ Error al intentar mover el ticket *${ticketKey}* al estado aprobado en Jira.`,
      replace_original: false
    });
  }
});

// =========================================================================
// ESCENARIO 1: WEBHOOK DE JIRA (CUMPLE AMBOS FLUJOS: MANUAL Y SLACK)
// =========================================================================
// Apunta tu Webhook de Jira a: https://hst-ar-bot.onrender.com/jira-webhook
expressApp.post('/jira-webhook', async (req, res) => {
  const issue = req.body.issue;
  
  if (!issue || !issue.fields) {
    return res.status(400).send('No issue data found');
  }

  const ticketKey = issue.key;
  const status = issue.fields.status.name;
  
  // Extracción de datos según la estructura dinámica de tu formulario en seat-sdc.atlassian.net
  const campoPadreArea = issue.fields.customfield_10623;       // HST Platform/Application: access request select area
  const campoHijoPlataforma = issue.fields.customfield_10620;  // HST Platform/Application: access request websites platform
  const userEmail = issue.fields.customfield_10088;            // Campo eMail

  // Este bloque unifica todo: el trigger salta tanto si el solver cambia a "Request Approved" manual, como si lo hace Slack
  if (status === 'Request Approved') {
    
    // Al ser un formulario dinámico, Jira puede enviar los CF como objetos { id: "XXXX" } o strings directo.
    const idPadre = campoPadreArea?.id || campoPadreArea;
    const idHijo = campoHijoPlataforma?.id || campoHijoPlataforma;

    console.log(`[Webhook Jira] Ticket ${ticketKey} detectado en Request Approved. Evaluando ruta: Padre=${idPadre}, Hijo=${idHijo}`);

    // VALIDACIÓN: ¿La ruta seleccionada equivale a Websites (12362) -> One.CMS (AEM) (12350)?
    if (idPadre === "12362" && idHijo === "12350") {
      console.log(`[TRIGGER AUTOMÁTICO] Ejecutando alta para ${userEmail} en Adobe CMS`);
      
      try {
        // Ejecución de la API de Adobe Admin Console pasándole el grupo correspondiente
        await crearUsuarioEnAdobe(userEmail, ["Adobe_CMS_Solvers_Group"]);
        
        // Escribimos un comentario automatizado en el ticket de Jira para dejar rastro e informar al solver final
        await axios.post(`https://${process.env.JIRA_DOMAIN}/rest/api/3/issue/${ticketKey}/comment`, {
          body: {
            type: "doc",
            version: 1,
            content: [{
              type: "paragraph",
              content: [{ type: "text", text: "🤖 [Bot] Alta de usuario gestionada y automatizada de forma exitosa en Adobe Admin Console para la tipología One.CMS (AEM)." }]
            }]
          }
        }, { headers: JIRA_HEADERS });

        return res.status(200).send('Adobe integration executed successfully.');
      } catch (error) {
        console.error(`[ERROR ADOBE] Fallo en el aprovisionamiento automatizado de ${ticketKey}:`, error.message);
        return res.status(500).send('Error creating user in Adobe Console.');
      }
    } else {
      console.log(`[INFO] El ticket ${ticketKey} está aprobado pero no pertenece a Adobe CMS. No se requiere automatización.`);
      return res.status(200).send('Approved ticket, but not matching Adobe CMS criteria.');
    }
  }

  res.status(200).send('No action taken. Status is not Request Approved.');
});

//
