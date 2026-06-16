const { App } = require('@slack/bolt');
const express = require('express');
const axios = require('axios');
require('dotenv').config();

// 1. Inicializar la App de Slack (Usa las Env Vars de Render)
const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: true
});

// 2. Inicializar Express para los Webhooks de Jira
const expressApp = express();
expressApp.use(express.json());
expressApp.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

// Configuración de credenciales de Jira
const JIRA_AUTH = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
const JIRA_HEADERS = {
  'Authorization': `Basic ${JIRA_AUTH}`,
  'Content-Type': 'application/json'
};

// ==========================================
// ESCENARIO 2: BOTÓN DE APROBACIÓN EN SLACK
// ==========================================
slackApp.action('approve_user_adobe', async ({ ack, body, respond }) => {
  await ack(); 
  
  const userId = body.user.id; 
  const ticketKey = body.actions[0].value; 
  const allowedApprovers = process.env.ALLOWED_APPROVERS ? process.env.ALLOWED_APPROVERS.split(',') : [];

  // Validar si quien pulsa en Slack está autorizado
  if (!allowedApprovers.includes(userId)) {
    await respond({
      text: `❌ <@${userId}>, no tienes permisos en negocio para aprobar esta solicitud.`,
      replace_original: false
    });
    return;
  }

  try {
    // Transicionamos el ticket al ID 21 (Request Approved)
    await transicionarTicketJira(ticketKey, "21");
    
    await respond({
      text: `✅ Solicitud del ticket *${ticketKey}* aprobada por <@${userId}>. Moviendo a Request Approved y creando en Adobe...`,
      replace_original: true
    });
  } catch (error) {
    console.error('Error al transicionar desde Slack:', error);
    await respond({
      text: `❌ Error al intentar mover el ticket ${ticketKey} a Request Approved en Jira.`,
      replace_original: false
    });
  }
});

// ==========================================
// ESCENARIO 1: WEBHOOK DE JIRA (TRIGGER GLOBAL)
// ==========================================
expressApp.post('/jira-webhook', async (req, res) => {
  const issue = req.body.issue;
  
  if (!issue || !issue.fields) {
    return res.status(400).send('No issue data found');
  }

  const ticketKey = issue.key;
  const status = issue.fields.status.name;
  
  // Extraemos los valores de tus campos dinámicos
  const campoPadreArea = issue.fields.customfield_10623; // HST Platform/Application: access request select area
  const campoHijoPlataforma = issue.fields.customfield_10620; // HST Platform/Application: access request websites platform
  const userEmail = issue.fields.customfield_10088; // Campo eMail

  // Validar si el ticket está en "Request Approved" (Da igual si llegó por el Solver o por Slack)
  if (status === 'Request Approved') {
    
    // VALIDACIÓN DINÁMICA: ¿Es una petición de Websites -> One.CMS (AEM)?
    // Jira a veces devuelve estos campos como objetos { id: "12362" } o strings. Validamos ambos casos:
    const idPadre = campoPadreArea?.id || campoPadreArea;
    const idHijo = campoHijoPlataforma?.id || campoHijoPlataforma;

    if (idPadre === "12362" && idHijo === "12350") {
      console.log(`[TRIGGER] El ticket ${ticketKey} cumple las condiciones de Adobe CMS. Iniciando aprovisionamiento para: ${userEmail}`);
      
      try {
        // Llamada a la API de Adobe
        await crearUsuarioEnAdobe(userEmail, ["Adobe_CMS_Solvers_Group"]); // Pasamos el grupo de AEM directamente
        
        // Añadir comentario de éxito en Jira
        await axios.post(`https://${process.env.JIRA_DOMAIN}/rest/api/3/issue/${ticketKey}/comment`, {
          body: {
            type: "doc",
            version: 1,
            content: [{
              type: "paragraph",
              content: [{ type: "text", text: "🤖 [Bot] Alta automatizada completada con éxito en Adobe Admin Console para la tipología One.CMS (AEM)." }]
            }]
          }
        }, { headers: JIRA_HEADERS });

        return res.status(200).send('Adobe Provisioning Done.');
      } catch (error) {
        console.error('Error en proceso Adobe:', error.message);
        return res.status(500).send('Error creating Adobe user.');
      }
    } else {
      console.log(`[INFO] El ticket ${ticketKey} está aprobado pero no es de tipología Adobe CMS (Padre: ${idPadre}, Hijo: ${idHijo}). Se ignora.`);
      return res.status(200).send('Not an Adobe CMS request.');
    }
  }

  res.status(200).send('No action needed for this status.');
});

// Endpoint receptor interactivo para Slack
expressApp.post('/slack/events', async (req, res) => {
  if (req.body.payload) {
    req.body = JSON.parse(req.body.payload);
  }
  res.sendStatus(200);
});

// ==========================================
// FUNCIONES DE CONEXIÓN (APIs)
// ==========================================

async function transicionarTicketJira(ticketKey, transitionId) {
  const url = `https://${process.env.JIRA_DOMAIN}/rest/api/3/issue/${ticketKey}/transitions`;
  const payload = {
    transition: {
      id: transitionId // Aquí viaja el ID 21 que confirmaste
    }
  };

  await axios.post(url, payload, { headers: JIRA_HEADERS });
  console.log(`[Jira API] Ticket ${ticketKey} movido exitosamente usando la transición ${transitionId}.`);
}

async function crearUsuarioEnAdobe(email, gruposAsignar) {
  console.log(`[Adobe API] Simulando/Llamando alta para ${email} en grupos:`, gruposAsignar);
  // Aquí va tu llamada con las credenciales de Adobe Admin Console
  // Usando process.env.ADOBE_ORGANIZATION_ID, etc.
}

expressApp.listen(PORT, () => {
  console.log(`Orquestador IT corriendo en el puerto ${PORT}`);
});
