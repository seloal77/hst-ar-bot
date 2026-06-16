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
// 3. ESCENARIO 2: INTERACTIVIDAD SL
