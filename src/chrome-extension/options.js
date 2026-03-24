// Docreview Chrome Extension — Options page

var baseUrlInput = document.getElementById('baseUrl');
var enableDocsInput = document.getElementById('enableDocs');
var enableCommentSyncInput = document.getElementById('enableCommentSync');
var enableDriveInput = document.getElementById('enableDrive');
var enableGmailInput = document.getElementById('enableGmail');
var enableResolveInput = document.getElementById('enableResolve');
var saveButton = document.getElementById('save');
var cancelButton = document.getElementById('cancel');

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
});

// Save and close
saveButton.addEventListener('click', function() {
  var url = baseUrlInput.value.replace(/\/+$/, ''); // strip trailing slashes
  chrome.storage.sync.set({
    baseUrl: url,
    enableDocs: enableDocsInput.checked,
    enableCommentSync: enableCommentSyncInput.checked,
    enableDrive: enableDriveInput.checked,
    enableGmail: enableGmailInput.checked,
    enableResolve: enableResolveInput.checked
  }, function() {
    window.close();
  });
});

// Cancel
cancelButton.addEventListener('click', function() {
  window.close();
});
