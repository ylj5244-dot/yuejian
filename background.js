// Invoke the extension action explicitly. The automatic side-panel toggle does
// not reliably grant activeTab and suppresses action.onClicked.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(console.error);
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(console.error);
chrome.action.onClicked.addListener((tab) => {
  // Keep open() directly in the gesture; do not await storage or tab queries first.
  chrome.sidePanel.open({ windowId: tab.windowId }).then(() => {
    // An existing panel must discard its previous URL-less tab snapshot. A new
    // panel may not be listening yet; startup refreshes the same target and
    // reads it if the user's auto-read setting is enabled.
    return chrome.runtime.sendMessage({ type: 'yuejian:read-current-tab', windowId: tab.windowId, tabId: tab.id });
  }).catch(() => { /* A newly opening panel can have no message receiver yet. */ });
});
