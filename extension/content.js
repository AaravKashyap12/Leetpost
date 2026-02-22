console.log('LeetPost: Content script loaded');

// Simple cache to store generated post for the current session/problem
let postCache = {
  post: null,
  problemTitle: null,
  problemSlug: null
};

// Listen for page load
window.addEventListener('load', function () {
  console.log('LeetPost: Page loaded, initializing...');
  initLeetPostAI();
});

// Also run on DOMContentLoaded for the post-solution page
// (window 'load' might fire after the SPA route change)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    if (window.location.pathname.includes('/post-solution/')) {
      setTimeout(() => initLeetPostAI(), 2000);
    }
  });
} else {
  // Already loaded (SPA navigation)
  if (window.location.pathname.includes('/post-solution/')) {
    setTimeout(() => initLeetPostAI(), 2000);
  }
}

// Listen for messages from popup (history re-open)
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'showPost' && request.post) {
    showPostModal(request.post, null);
  }
});

function initLeetPostAI() {
  // ── Auto-fill on post-solution page ──────────────────────────────────────
  if (window.location.pathname.includes('/post-solution/')) {
    chrome.storage.local.get(['autoPasteTitle', 'autoPasteBody'], (data) => {
      if (!data.autoPasteBody) return; // nothing to paste
      tryAutoFill(data.autoPasteTitle || '', data.autoPasteBody, 0);
    });
    return; // don't inject the generate button on this page
  }

  // ── Normal problem page: inject generate button ───────────────────────────
  if (!window.location.pathname.includes('/problems/')) {
    console.log('LeetPost: Not on a problem page');
    return;
  }

  console.log('LeetPost: Problem page detected, starting observer...');
  setTimeout(() => { checkForAcceptedSubmission(); }, 1500);
}

// Retry filling title + body since LeetCode's editor uses React and renders late
function tryAutoFill(title, body, attempt) {
  if (attempt > 30) {
    console.log('LeetPost: Auto-fill gave up after 15s');
    return;
  }

  // Title: the "Enter your title" input at the top
  const titleInput = document.querySelector('input[placeholder="Enter your title"]') ||
    document.querySelector('input[placeholder*="title" i]') ||
    document.querySelector('input[type="text"]');

  // Body: LeetCode uses a ProseMirror contenteditable div
  const editor = document.querySelector('div.ProseMirror') ||
    document.querySelector('div[contenteditable="true"]') ||
    document.querySelector('.CodeMirror');

  if (!titleInput || !editor) {
    setTimeout(() => tryAutoFill(title, body, attempt + 1), 500);
    return;
  }

  // ── Fill title ──────────────────────────────────────────────────────────
  if (title) {
    // React-controlled input needs nativeInputValueSetter
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ).set;
    nativeInputValueSetter.call(titleInput, title);
    titleInput.dispatchEvent(new Event('input', { bubbles: true }));
    titleInput.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ── Fill body ───────────────────────────────────────────────────────────
  if (editor.classList.contains('CodeMirror')) {
    // CodeMirror
    const cm = editor.CodeMirror;
    if (!cm) { setTimeout(() => tryAutoFill(title, body, attempt + 1), 500); return; }
    cm.setValue(body);
    cm.refresh();
  } else {
    // ProseMirror / contenteditable — use execCommand so React sees the change
    editor.focus();
    // Select all existing default content
    document.execCommand('selectAll', false, null);
    // Insert our text (triggers the React state update)
    document.execCommand('insertText', false, body);
  }

  // Clear storage so it doesn't re-fill on next visit
  chrome.storage.local.remove(['autoPasteTitle', 'autoPasteBody']);
  console.log('LeetPost: ✅ Auto-filled the post-solution form!');
}

function checkForAcceptedSubmission() {
  // Look for "Accepted" status with broader selectors
  const statusElement = document.querySelector('[class*="accepted"]') ||
    document.querySelector('[data-e2e-locator="submission-result"]') ||
    document.querySelector('.text-lc-green-60') ||
    document.querySelector('.success__3V99');

  if (!statusElement) {
    // If we're on the submission list page, we might not want to inject next to EVERY accepted item
    // but just check if there is an accepted status at all.
    console.log('LeetPost: Status element not found, retrying...');
    setTimeout(checkForAcceptedSubmission, 2000);
    return;
  }

  const statusText = statusElement.textContent.toLowerCase();

  if (statusText.includes('accepted')) {
    console.log('LeetPost: Accepted solution detected!');
    injectGenerateButton(statusElement);
  } else {
    // Keep checking, user might submit while on page
    setTimeout(checkForAcceptedSubmission, 3000);
  }
}

function injectGenerateButton(statusElement) {
  // Check if button already exists
  if (document.getElementById('leetpost-generate-btn')) {
    return;
  }

  // Create the button
  const button = document.createElement('button');
  button.id = 'leetpost-generate-btn';
  button.className = 'leetpost-btn';
  button.innerHTML = `Generate Post`;

  // Add click handler
  button.addEventListener('click', handleGenerateClick);

  // Target the specific action group that contains Solution/Sync buttons
  const actionGroup = document.querySelector('a[href*="/solution"]')?.parentElement?.parentElement ||
    document.querySelector('a[href*="/editorial"]')?.parentElement?.parentElement ||
    document.querySelector('div[class*="gap-4"] > .leethub-btn')?.parentElement;

  if (actionGroup) {
    // If we're on the submission list, don't inject here
    if (window.location.pathname.includes('/submissions/')) {
      const statusRow = statusElement?.closest('div[class*="flex"]') || statusElement?.parentElement;
      statusRow?.appendChild(button);
    } else {
      // Insert after the first few elements to sit nicely next to Editorial/Solution
      actionGroup.appendChild(button);
    }
    console.log('LeetPost: Button injected into action group');
  } else if (statusElement) {
    // If no group, inject near status but wrapped to maintain alignment
    const wrapper = document.createElement('div');
    wrapper.style.display = 'inline-flex';
    wrapper.style.alignItems = 'center';
    wrapper.style.verticalAlign = 'middle';
    wrapper.appendChild(button);
    statusElement.parentElement.insertBefore(wrapper, statusElement.nextSibling);
    console.log('LeetPost: Button injected with wrapper next to status');
  } else {
    // Fallback: fixed position to never break layout
    button.style.position = 'fixed';
    button.style.bottom = '24px';
    button.style.right = '24px';
    button.style.zIndex = '99999';
    document.body.appendChild(button);
  }
}

async function handleGenerateClick(e) {
  e.preventDefault();
  const button = e.currentTarget;

  const submissionData = await extractSubmissionData();
  if (!submissionData) {
    alert('Could not extract submission data');
    return;
  }

  // If we already have a cached post for this problem, show it immediately
  if (postCache.problemSlug === submissionData.slug && postCache.post) {
    showPostModal(postCache.post, postCache.problemTitle);
    return;
  }

  generateNewPost(button, submissionData);
}

async function generateNewPost(button, submissionData) {
  button.disabled = true;
  button.innerHTML = `Generating...`;

  try {
    console.log('LeetPost: Generating new post for:', submissionData.title);

    if (!chrome.runtime || !chrome.runtime.sendMessage) {
      alert('Extension context invalidated. Please refresh the page.');
      resetButton(button);
      return;
    }

    chrome.runtime.sendMessage(
      { action: 'generatePost', data: submissionData },
      (response) => {
        if (chrome.runtime.lastError) {
          alert('Extension context lost. Please refresh the page.');
          resetButton(button);
          return;
        }
        if (response && response.success) {
          // Update cache
          postCache = {
            post: response.post,
            problemTitle: submissionData.title,
            problemSlug: submissionData.slug
          };
          showPostModal(response.post, submissionData.title);
        } else {
          alert('Error: ' + (response ? response.error : 'Unknown error'));
        }
        resetButton(button);
      }
    );
  } catch (error) {
    console.error('LeetPost: Error in generation flow:', error);
    alert('Error generating post. See console for details.');
    resetButton(button);
  }
}

function resetButton(button) {
  button.disabled = false;
  button.innerHTML = `Generate Post`;
}

async function extractSubmissionData() {
  const urlMatch = window.location.pathname.match(/\/problems\/([^/]+)\//);
  const problemSlug = urlMatch ? urlMatch[1] : null;

  // ── Problem Title: try many selectors across LeetCode's layouts ───────────
  let problemTitle = '';

  const titleSelectors = [
    '[data-cy="question-title"]',
    'div.text-title-large a',
    'a.no-underline[href*="/problems/"]',
    'div[class*="question-title"]',
    '.mr-2.text-label-1',
    '.css-v3d350',
  ];

  for (const sel of titleSelectors) {
    const el = document.querySelector(sel);
    if (el && el.textContent.trim()) {
      problemTitle = el.textContent.trim();
      break;
    }
  }

  // Fallback: parse <title> tag → "Two Sum - LeetCode" or "1. Two Sum - LeetCode"
  if (!problemTitle && document.title) {
    const m = document.title.match(/^(.+?)\s*[-|]/);
    if (m) problemTitle = m[1].trim();
  }

  // Last resort: slug → Title Case
  if (!problemTitle && problemSlug) {
    problemTitle = problemSlug.split('-').map(w =>
      w.charAt(0).toUpperCase() + w.slice(1)
    ).join(' ');
  }

  // ── Code ──────────────────────────────────────────────────────────────────
  let code = '';

  const codeMirror = document.querySelector('.CodeMirror');
  if (codeMirror && codeMirror.CodeMirror) code = codeMirror.CodeMirror.getValue();

  if (!code) {
    const pre = document.querySelector('pre');
    if (pre) code = pre.textContent;
  }
  if (!code) {
    const codeEl = document.querySelector('code');
    if (codeEl) code = codeEl.textContent;
  }

  // ── Language ──────────────────────────────────────────────────────────────
  let language = 'Unknown';
  const langEl = document.querySelector('[data-cy="lang-select"]') ||
    document.querySelector('.lang-label');
  if (langEl) language = langEl.textContent.trim();
  if (language === 'Unknown' && code) language = detectLanguageFromCode(code);

  return {
    title: problemTitle,
    slug: problemSlug,
    code: code.trim(),
    language,
    description: 'See LeetCode for problem details.',
    url: window.location.href
  };
}

function detectLanguageFromCode(code) {
  if (code.includes('public class') || code.includes('public static')) return 'Java';
  if (code.includes('def ') && code.includes(':')) return 'Python';
  if (code.includes('#include')) return 'C++';
  if (code.includes('function') || code.includes('=>') || code.includes('const ')) return 'JavaScript';
  if (code.includes('func ') && code.includes('->')) return 'Swift';
  if (code.includes('fn ') && code.includes('->')) return 'Rust';
  return 'Unknown';
}

function showPostModal(post, problemTitle) {
  const overlay = document.createElement('div');
  overlay.id = 'leetpost-modal-overlay';
  overlay.className = 'leetpost-modal-overlay';

  // Extract the AI-generated viral hook (first # line)
  const hookMatch = post.match(/^#\s+(.+)$/m);
  const extractedTitle = (hookMatch ? hookMatch[1].trim() : null) || problemTitle || 'LeetCode Solution';

  // Strip the # title line from the body for clean separation
  const bodyWithoutTitle = post.replace(/^#\s+.+\n?/m, '').trimStart();

  const modal = document.createElement('div');
  modal.className = 'leetpost-modal';
  modal.innerHTML = `
    <div class="leetpost-modal-header">
      <h2>✨ Your Post is Ready!</h2>
      <button class="leetpost-close-btn" onclick="this.closest('.leetpost-modal-overlay').remove()">×</button>
    </div>
    <div class="leetpost-modal-body">
      <div class="leetpost-title-row">
        <label class="leetpost-title-label">📌 Title</label>
        <div class="leetpost-title-box">
          <span id="leetpost-title-text">${extractedTitle}</span>
          <button class="leetpost-title-copy-btn" id="leetpost-title-copy-btn">Copy Title</button>
        </div>
      </div>
      <label class="leetpost-title-label" style="margin-top:12px;display:block">📝 Body</label>
      <textarea id="leetpost-generated-post" readonly>${bodyWithoutTitle}</textarea>
    </div>
    <div class="leetpost-modal-footer">
      <button class="leetpost-copy-btn" id="leetpost-copy-btn">📋 Copy Body</button>
      <button class="leetpost-paste-btn" id="leetpost-paste-btn">🚀 Open & Paste</button>
      <button class="leetpost-regen-btn" id="leetpost-regen-btn">🔄 Regenerate</button>
      <button class="leetpost-close-btn" onclick="this.closest('.leetpost-modal-overlay').remove()">Close</button>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Regenerate button
  document.getElementById('leetpost-regen-btn').addEventListener('click', async () => {
    const btn = document.getElementById('leetpost-regen-btn');
    const mainBtn = document.getElementById('leetpost-generate-btn');

    // Close current modal
    overlay.remove();

    // Clear cache for this problem to force new generation
    postCache.post = null;

    // Trigger new generation
    const submissionData = await extractSubmissionData();
    if (submissionData) {
      generateNewPost(mainBtn, submissionData);
    }
  });

  // Copy Title button
  document.getElementById('leetpost-title-copy-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(extractedTitle).then(() => {
      const btn = document.getElementById('leetpost-title-copy-btn');
      btn.innerHTML = '✅ Copied!';
      setTimeout(() => { btn.innerHTML = 'Copy Title'; }, 2000);
    });
  });

  // Copy Body button
  document.getElementById('leetpost-copy-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(bodyWithoutTitle).then(() => {
      const btn = document.getElementById('leetpost-copy-btn');
      btn.innerHTML = '✅ Copied!';
      setTimeout(() => { btn.innerHTML = '📋 Copy Body'; }, 2000);
    });
  });

  // Open & Paste: copy to clipboard and open post-solution page
  document.getElementById('leetpost-paste-btn').addEventListener('click', () => {
    const slugMatch = window.location.pathname.match(/\/problems\/([^/]+)/);
    const slug = slugMatch ? slugMatch[1] : null;

    const submissionMatch = window.location.pathname.match(/\/submissions\/(\d+)/);
    const submissionId = submissionMatch ? submissionMatch[1] : null;

    if (!slug) {
      alert('Could not detect problem. Please open a submission page first.');
      return;
    }

    // Copy body to clipboard (title is separate)
    navigator.clipboard.writeText(bodyWithoutTitle).then(() => {
      const btn = document.getElementById('leetpost-paste-btn');
      btn.innerHTML = '✅ Copied! Opening...';

      const shareUrl = submissionId
        ? `https://leetcode.com/problems/${slug}/post-solution/?submissionId=${submissionId}`
        : `https://leetcode.com/problems/${slug}/post-solution/`;

      // Small delay so user sees the confirmation, then open
      setTimeout(() => {
        window.open(shareUrl, '_blank');
        btn.innerHTML = '🚀 Open & Paste';
      }, 800);
    }).catch(() => {
      alert('Could not copy to clipboard. Please use the Copy button instead.');
    });
  });

  // Close on overlay click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
}

// Listen for navigation changes (SPA)
let lastUrl = location.href;
new MutationObserver(() => {
  const url = location.href;
  if (url !== lastUrl) {
    lastUrl = url;
    initLeetPostAI();
  }
}).observe(document, { subtree: true, childList: true });
