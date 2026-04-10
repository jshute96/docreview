// Docreview Chrome Extension — Options page

var baseUrlInput = document.getElementById('baseUrl');
var enableDocsInput = document.getElementById('enableDocs');
var enableCommentSyncInput = document.getElementById('enableCommentSync');
var enableDriveInput = document.getElementById('enableDrive');
var enableGmailInput = document.getElementById('enableGmail');
var enableResolveInput = document.getElementById('enableResolve');
var saveButton = document.getElementById('save');
// Auto-size URL input to fit its content (min 600px via CSS)
function autoSizeUrl() {
  baseUrlInput.style.width = '0';
  baseUrlInput.style.width = Math.max(600, baseUrlInput.scrollWidth + 16) + 'px';
}
baseUrlInput.addEventListener('input', autoSizeUrl);

// Comment sync checkbox is only enabled when docs is checked
function updateCommentSyncState() {
  enableCommentSyncInput.disabled = !enableDocsInput.checked;
  if (!enableDocsInput.checked) {
    enableCommentSyncInput.checked = false;
  }
}
enableDocsInput.addEventListener('change', updateCommentSyncState);

// Load current values
chrome.storage.sync.get({
  baseUrl: DEFAULTS.baseUrl,
  enableDocs: DEFAULTS.enableDocs,
  enableCommentSync: DEFAULTS.enableCommentSync,
  enableDrive: DEFAULTS.enableDrive,
  enableGmail: DEFAULTS.enableGmail,
  enableResolve: DEFAULTS.enableResolve
}, function(data) {
  baseUrlInput.value = data.baseUrl;
  enableDocsInput.checked = data.enableDocs;
  enableCommentSyncInput.checked = data.enableCommentSync;
  enableDriveInput.checked = data.enableDrive;
  enableGmailInput.checked = data.enableGmail;
  enableResolveInput.checked = data.enableResolve;
  updateCommentSyncState();
  autoSizeUrl();
  document.body.style.visibility = '';
});

// Save and close
saveButton.addEventListener('click', function() {
  var url = baseUrlInput.value.trim().replace(/\/+$/, ''); // strip whitespace then trailing slashes
  baseUrlInput.value = url;
  autoSizeUrl();
  chrome.storage.sync.set({
    baseUrl: url,
    enableDocs: enableDocsInput.checked,
    enableCommentSync: enableCommentSyncInput.checked,
    enableDrive: enableDriveInput.checked,
    enableGmail: enableGmailInput.checked,
    enableResolve: enableResolveInput.checked
  }, function() {
    saveButton.textContent = 'Saved';
    setTimeout(function() { saveButton.textContent = 'Save'; }, 1500);
  });
});

