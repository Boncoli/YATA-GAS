// check-api.js
require('./gas-bridge.js');

async function check() {
  console.log("--- OpenWeatherMap API Check ---");
  const weatherUrl = `https://api.openweathermap.org/data/3.0/onecall?lat=${process.env.LAT}&lon=${process.env.LON}&exclude=minutely,hourly,daily&units=metric&lang=ja&appid=${process.env.OWM_API_KEY}`;
  try {
    const resW = UrlFetchApp.fetch(weatherUrl);
    console.log(JSON.stringify(JSON.parse(resW.getContentText()), null, 2));
  } catch(e) { console.error("Weather API Error"); }

  console.log("\n--- Nature Remo API Check ---");
  const remoUrl = "https://api.nature.global/1/devices";
  const remoOptions = {
    "headers": { 'Authorization': 'Bearer ' + process.env.REMO_ACCESS_TOKEN }
  };
  try {
    const resR = UrlFetchApp.fetch(remoUrl, remoOptions);
    console.log(JSON.stringify(JSON.parse(resR.getContentText()), null, 2));
  } catch(e) { console.error("Remo API Error"); }
}

check();