// popup.js – Handles Settings, Profile, and History tabs

document.addEventListener('DOMContentLoaded', function () {
  loadSettings();
  loadProfile();
  loadHistory();

  // Tab switching
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
      if (tab.dataset.tab === 'history') loadHistory();
    });
  });

  document.getElementById('saveSettingsBtn').addEventListener('click', saveSettings);
  document.getElementById('saveProfileBtn').addEventListener('click', saveProfile);
  document.getElementById('clearHistoryBtn').addEventListener('click', clearHistory);

  // Update link based on provider
  document.getElementById('apiProvider').addEventListener('change', updateProviderLink);
});

function updateProviderLink() {
  const provider = document.getElementById('apiProvider').value;
  const link = document.getElementById('apiKeyLink');
  const help = document.getElementById('apiKeyHelpText');

  if (provider === 'groq') {
    link.href = 'https://console.groq.com/keys';
    link.textContent = 'Get Groq key →';
    help.firstChild.textContent = 'A shared key is included for Groq. ';
  } else if (provider === 'gemini') {
    link.href = 'https://aistudio.google.com/app/apikey';
    link.textContent = 'Get Gemini key →';
    help.firstChild.textContent = 'A shared key is included for Gemini. ';
  } else if (provider === 'openai') {
    link.href = 'https://platform.openai.com/api-keys';
    link.textContent = 'Get OpenAI key →';
    help.firstChild.textContent = 'Requires paid OpenAI credits. ';
  }
}

// ------ SETTINGS ------
function loadSettings() {
  chrome.storage.sync.get(['apiKey', 'apiProvider'], function (data) {
    if (data.apiKey) document.getElementById('apiKey').value = data.apiKey;

    // Default to groq if not set
    const provider = data.apiProvider || 'groq';
    document.getElementById('apiProvider').value = provider;
    updateProviderLink();
  });
}

function saveSettings() {
  const apiKey = document.getElementById('apiKey').value.trim();
  const apiProvider = document.getElementById('apiProvider').value;

  // API key is optional — empty means use the built-in shared key
  chrome.storage.sync.set({ apiKey, apiProvider }, () => {
    showStatus('settings-status', '✓ Saved! ' + (apiKey ? 'Using your key.' : 'Using built-in key.'), 'success');
  });
}

// ------ PROFILE ------
function loadProfile() {
  chrome.storage.sync.get(['profileName', 'profileLinkedIn', 'profileGithub', 'profileSignoff'], (data) => {
    if (data.profileName) document.getElementById('profileName').value = data.profileName;
    if (data.profileLinkedIn) document.getElementById('profileLinkedIn').value = data.profileLinkedIn;
    if (data.profileGithub) document.getElementById('profileGithub').value = data.profileGithub;
    if (data.profileSignoff) document.getElementById('profileSignoff').value = data.profileSignoff;
  });
}

function saveProfile() {
  const profile = {
    profileName: document.getElementById('profileName').value.trim(),
    profileLinkedIn: document.getElementById('profileLinkedIn').value.trim(),
    profileGithub: document.getElementById('profileGithub').value.trim(),
    profileSignoff: document.getElementById('profileSignoff').value.trim(),
  };

  chrome.storage.sync.set(profile, () => {
    showStatus('profile-status', '✓ Profile saved!', 'success');
  });
}

// ------ HISTORY ------
function loadHistory() {
  chrome.storage.local.get(['postHistory'], (data) => {
    const history = data.postHistory || [];
    const listEl = document.getElementById('historyList');

    if (history.length === 0) {
      listEl.innerHTML = `<div class="history-empty">No posts generated yet.<br>Generate your first post on LeetCode!</div>`;
      return;
    }

    listEl.innerHTML = history.slice().reverse().map((item, idx) => `
      <div class="history-item" data-idx="${history.length - 1 - idx}">
        <div class="hi-title">📄 ${item.title || item.slug || 'Unknown Problem'}</div>
        <div class="hi-meta">${item.date} &nbsp;·&nbsp; ${item.language || 'Unknown'}</div>
      </div>
    `).join('');

    listEl.querySelectorAll('.history-item').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.idx);
        const post = history[idx].post;

        // Send to active tab to show in modal
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          chrome.tabs.sendMessage(tabs[0].id, { action: 'showPost', post });
          window.close();
        });
      });
    });
  });
}

function clearHistory() {
  chrome.storage.local.set({ postHistory: [] }, () => {
    loadHistory();
  });
}

// ------ UTILS ------
function showStatus(elId, message, type) {
  const el = document.getElementById(elId);
  el.textContent = message;
  el.className = 'status ' + type;
  setTimeout(() => { el.textContent = ''; el.className = 'status'; }, 3000);
}
