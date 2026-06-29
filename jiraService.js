// jiraService.js
const axios = require('axios');

const JIRA_AUTH = Buffer.from(`${process.env.JIRA_EMAIL || ''}:${process.env.JIRA_API_TOKEN || ''}`).toString('base64');

const JIRA_HEADERS = {
  'Authorization': `Basic ${JIRA_AUTH}`,
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'X-ExperimentalApi': 'opt-in'
};

/**
 * Searches for an existing user or creates a new one in Jira Cloud
 */
async function asegurarUsuarioEnJira(email, firstName, lastName) {
  try {
    const searchUrl = `https://${process.env.JIRA_DOMAIN}/rest/api/3/user/search?query=${encodeURIComponent(email)}`;
    const searchRes = await axios.get(searchUrl, { headers: JIRA_HEADERS });
    
    let accountId = null;

    if (searchRes.data && searchRes.data.length > 0) {
      accountId = searchRes.data[0].accountId;
    } else {
      const coreUserUrl = `https://${process.env.JIRA_DOMAIN}/rest/api/3/user`;
      const payloadCore = { emailAddress: email, displayName: `${firstName} ${lastName}`, products: [] };
      const createRes = await axios.post(coreUserUrl, payloadCore, { headers: JIRA_HEADERS });
      
      if (createRes.data && createRes.data.accountId) {
        accountId = createRes.data.accountId;
      } else {
        return { success: false, errorReason: "Core User API did not return an accountId" };
      }
    }
    return { success: true, accountId: accountId };
  } catch (error) {
    return { success: false, errorReason: error.message };
  }
}

module.exports = { asegurarUsuarioEnJira, JIRA_HEADERS };
