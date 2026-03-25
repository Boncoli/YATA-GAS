require('../lib/yata-loader.js');

async function test() {
  const LlmService = global.LlmService;
  // Monkey patch _httpFetch to intercept the response and dump json.usage
  const originalFetch = global.UrlFetchApp.fetch;
  global.UrlFetchApp.fetch = function(url, options) {
    const res = originalFetch(url, options);
    const content = res.getContentText();
    try {
      const json = JSON.parse(content);
      console.log("=== RAW JSON USAGE ===");
      console.log(JSON.stringify(json.usage, null, 2));
      console.log("======================");
    } catch(e) {}
    return {
      getResponseCode: () => res.getResponseCode(),
      getContentText: () => content
    };
  };

  try {
    LlmService.summarizeBatch(["Test article 1. This is just a short text to see the usage structure."]);
  } catch(e) {
    console.error(e);
  }
}
test();
