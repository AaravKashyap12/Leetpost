// Background service worker
console.log('LeetPost: Background script loaded');

// Load built-in keys if they exist (local config)
try {
  importScripts('config.js');
} catch (e) {
  console.log('LeetPost: No local config.js found, will use hardcoded or user keys.');
}

// Listen for messages from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'generatePost') {
    generatePost(request.data)
      .then(post => sendResponse({ success: true, post }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // async
  }

  if (request.action === 'openAndPaste') {
    const { url, title, body } = request;

    // Open the post-solution tab
    chrome.tabs.create({ url }, (tab) => {
      const tabId = tab.id;

      // Wait for the tab to FULLY load, then inject fill script
      const listener = (updatedTabId, changeInfo) => {
        if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;

        // Tab is fully loaded — now inject the fill script
        chrome.scripting.executeScript({
          target: { tabId },
          func: fillPostSolutionForm,
          args: [title, body],
        });

        chrome.tabs.onUpdated.removeListener(listener);
      };

      chrome.tabs.onUpdated.addListener(listener);
    });

    return false;
  }
});

// This function is INJECTED into the post-solution tab — keep it self-contained
function fillPostSolutionForm(title, body) {
  let attempts = 0;

  function fill() {
    attempts++;
    if (attempts > 40) return; // 20s timeout

    // Title input
    const titleInput = document.querySelector('input[placeholder="Enter your title"]') ||
      document.querySelector('input[placeholder*="title" i]');

    // ProseMirror editor (LeetCode's rich text editor)
    const editor = document.querySelector('.ProseMirror') ||
      document.querySelector('div[contenteditable="true"]');

    if (!titleInput || !editor) {
      setTimeout(fill, 500);
      return;
    }

    // Fill title using React's native setter
    if (title) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(titleInput, title);
      titleInput.dispatchEvent(new Event('input', { bubbles: true }));
      titleInput.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // Fill body: select all default content and replace with ours
    editor.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, body);

    console.log('LeetPost ✅ Auto-filled!');
  }

  // Start after a short delay to let React fully mount the editor
  setTimeout(fill, 1500);
}

async function generatePost(submissionData) {
  try {
    const settings = await chrome.storage.sync.get([
      'apiKey', 'apiProvider',
      'profileName', 'profileLinkedIn', 'profileGithub', 'profileSignoff'
    ]);

    // Fall back to built-in keys if user hasn't set one
    // These now pull from config.js (ignored by git) or use placeholders
    const BUILT_IN_GEMINI_KEY = (typeof BUILT_IN_CONFIG !== 'undefined') ? BUILT_IN_CONFIG.GEMINI_KEY : 'YOUR_GEMINI_KEY_PLACEHOLDER';
    const BUILT_IN_GROQ_KEY = (typeof BUILT_IN_CONFIG !== 'undefined') ? BUILT_IN_CONFIG.GROQ_KEY : 'YOUR_GROQ_KEY_PLACEHOLDER';

    const apiProvider = settings.apiProvider || 'groq';
    let apiKey = settings.apiKey;

    // Check if the saved key actually belongs to the current provider
    const isGroqKey = apiKey && apiKey.startsWith('gsk_');
    const isGeminiKey = apiKey && apiKey.startsWith('AIza');

    if (!apiKey || (apiProvider === 'groq' && !isGroqKey) || (apiProvider === 'gemini' && !isGeminiKey)) {
      apiKey = (apiProvider === 'gemini') ? BUILT_IN_GEMINI_KEY : BUILT_IN_GROQ_KEY;
    }

    // Attach profile to submission data for prompt injection
    submissionData.profile = {
      name: settings.profileName || 'Aarav Kashyap',
      linkedin: settings.profileLinkedIn || 'aaravkashyapsingh',
      github: settings.profileGithub || 'aaravkashyap12',
      signoff: settings.profileSignoff || '⭐ If this helped you, please consider upvoting!',
    };

    const post = await generateDirectly(apiProvider, apiKey, submissionData);

    // Save to history
    await saveToHistory({ title: submissionData.title, language: submissionData.language, post });

    return post;
  } catch (error) {
    console.error('LeetPost: Error generating post:', error);
    throw error;
  }
}

async function saveToHistory(entry) {
  const result = await chrome.storage.local.get(['postHistory']);
  const history = result.postHistory || [];
  const date = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

  // Extract the AI-generated viral hook (first # line) from the post
  const hookMatch = entry.post ? entry.post.match(/^#\s+(.+)$/m) : null;
  const displayTitle = hookMatch ? hookMatch[1].trim() : (entry.title || 'Unknown Problem');

  const historyEntry = {
    ...entry,
    title: displayTitle,
    problemName: entry.title, // Keep original name for meta if needed
    date: date
  };

  history.push(historyEntry);
  // Keep only last 20
  if (history.length > 20) history.splice(0, history.length - 20);
  await chrome.storage.local.set({ postHistory: history });
}

async function generateViaBackend(backendUrl, submissionData) {
  const response = await fetch(backendUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(submissionData)
  });

  if (!response.ok) {
    throw new Error(`Backend error: ${response.statusText}`);
  }

  const data = await response.json();
  return data.post;
}

async function generateDirectly(apiProvider, apiKey, submissionData) {
  const prompt = createPrompt(submissionData);

  if (apiProvider === 'gemini') {
    return await callGemini(apiKey, prompt);
  } else if (apiProvider === 'groq') {
    return await callGroq(apiKey, prompt);
  } else if (apiProvider === 'openai') {
    return await callOpenAI(apiKey, prompt);
  } else {
    throw new Error('Unknown API provider: ' + apiProvider);
  }
}

function createPrompt(data) {
  const p = data.profile || {};
  const name = p.name || 'Aarav Kashyap';
  const linkedin = p.linkedin || 'aaravkashyapsingh';
  const github = p.github || 'aaravkashyap12';
  const signoff = p.signoff || '⭐ If this helped you, please consider upvoting!';
  const tone = 'Elite Educator (clear, insightful, conversational, and technical yet accessible)';

  return `You are an expert LeetCode solution generator. Your goal is to generate a high-engagement post using LeetCode's native "side-by-side" tab syntax.

### STRICT RULES:
1. **SIDE-BY-SIDE CODE**: You MUST use the \`lang []\` syntax in code fences (e.g., \`python []\`, \`cpp []\`). This is CRITICAL for LeetCode tabs.
2. **ONE VIRAL TITLE ONLY**: Start with EXACTLY ONE extremely catchy viral title using "# [Emoji] [Title]". Example: "🔥 99% Beats | O(n) Logic Simplified!" or "🚀 Stop Nesting Loops! Master the HashMap Approach".
3. **DO NOT OPTIMIZE**: Preserve the user's exact algorithm. If they used $O(n^2)$, keep it $O(n^2)$.
4. **TONE**: Write in an ${tone} style.
5. **STRUCTURE & EXPLANATION**:
   # [Viral Hook Title]
   **Intuition**
   Explain the "Aha!" moment. Instead of just stating facts, describe the mental shift needed to solve this. What makes this approach clever? Use relatable analogies.
   ---
   **Approach**
   Provide a detailed, step-by-step breakdown of the logic. Use bullet points. Ensure even a beginner can follow the sequence of thoughts.
   ---
   **Complexity**
   - **Time complexity:** $O(...)$
   - **Space complexity:** $O(...)$
   ---
   ## Code
   \`\`\`python []
   [Python]
   \`\`\`
   \`\`\`cpp []
   [C++]
   \`\`\`
   \`\`\`java []
   [Java]
   \`\`\`
   \`\`\`javascript []
   [JavaScript]
   \`\`\`
   ---
   ${signoff}
   Let's connect:
   🔗 LinkedIn: [${name}](https://linkedin.com/in/${linkedin})
   💻 GitHub: [${github}](https://github.com/${github})

---
INPUT DATA:
Problem: ${data.title}
User Logic (${data.language}): ${data.code}
Problem Context: ${data.description}

Generate the post now. Remember to use the [] in every code fence!`;
}

async function callGemini(apiKey, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [{
        parts: [{
          text: prompt
        }]
      }]
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemini API error: ${error}`);
  }

  const data = await response.json();
  return data.candidates[0].content.parts[0].text;
}

async function callGroq(apiKey, prompt) {
  const url = 'https://api.groq.com/openai/v1/chat/completions';

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{
        role: 'system',
        content: 'You are an expert DSA educator and LeetCode content creator.'
      }, {
        role: 'user',
        content: prompt
      }],
      temperature: 0.7,
      max_tokens: 2000
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Groq API error: ${error}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

async function callOpenAI(apiKey, prompt) {
  const url = 'https://api.openai.com/v1/chat/completions';

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4',
      messages: [{
        role: 'system',
        content: 'You are an expert DSA educator and LeetCode content creator.'
      }, {
        role: 'user',
        content: prompt
      }],
      temperature: 0.7,
      max_tokens: 2000
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${error}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}
