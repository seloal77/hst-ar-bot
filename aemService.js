// aemService.js
const axios = require('axios');

/**
 * Connects to Adobe User Management API v2 to provision a Federated ID and map groups
 */
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
        { "createFederatedID": { "email": email, "country": "ES", "firstname": firstName, "lastname": lastName } },
        { "add": { "group": grupos } }
      ]
    }];

    const apiResponse = await axios.post(adobeEndpoint, adobePayload, {
      headers: { 
        'Authorization': `Bearer ${accessToken}`, 
        'X-Api-Key': process.env.ADOBE_CLIENT_ID, 
        'Content-Type': 'application/json' 
      }
    });

    console.log(`📡 [ADOBE API DEBUG]:`, JSON.stringify(apiResponse.data));

    // 🔍 ANALIZADOR GLOBAL DE ERRORES Y ADAPTADOR DE MENSAJES AMIGABLES
    if (apiResponse.data?.errors?.length > 0) {
      const errorDetalle = apiResponse.data.errors[0];
      const errorCode = errorDetalle.errorCode || "";
      const errorMsg = errorDetalle.message || "";
      
      if (errorCode === "error.user.already_in_org") {
        return { success: true };
      }

      if (errorCode.includes("domain") || errorMsg.includes("directory") || errorCode === "country_not_accepted") {
        return { 
          success: false, 
          errorReason: `Identity policy restriction. Please go to Adobe Admin Console -> Settings -> Identity, select the corporate Directory and ensure the user's email domain and country are verified and mapped correctly.` 
        };
      }

      if (apiResponse.data?.completed > 0) {
        return { success: true };
      }

      return { success: false, errorReason: errorMsg || errorCode };
    }

    return { success: true };
  } catch (error) {
    let msg = error.message;
    if (error.response && error.response.data) msg = JSON.stringify(error.response.data);
    return { success: false, errorReason: msg };
  }
}

module.exports = { crearUsuarioEnAdobe };
