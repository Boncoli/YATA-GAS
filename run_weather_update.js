require('./lib/gas-bridge.js');
const fetchWeather = require('./modules/get-weather.js');

(async () => {
    console.log("Running weather update...");
    await fetchWeather();
    console.log("Done.");
})();
