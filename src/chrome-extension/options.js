// Docreview Chrome Extension — Options page

var baseUrlInput = document.getElementById('baseUrl');
var saveButton = document.getElementById('save');
var cancelButton = document.getElementById('cancel');

// Load current value
chrome.storage.sync.get({ baseUrl: DEFAULTS.baseUrl }, function(data) {
  baseUrlInput.value = data.baseUrl;
});

// Save and close
saveButton.addEventListener('click', function() {
  var url = baseUrlInput.value.replace(/\/+$/, ''); // strip trailing slashes
  chrome.storage.sync.set({ baseUrl: url }, function() {
    window.close();
  });
});

// Cancel
cancelButton.addEventListener('click', function() {
  window.close();
});
