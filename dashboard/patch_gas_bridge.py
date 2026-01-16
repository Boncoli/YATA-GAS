import os
path = os.path.expanduser("~/yata-local/lib/gas-bridge.js")
with open(path, 'r') as f:
    content = f.read()

old_block = """  CREATE TABLE IF NOT EXISTS log (timestamp TEXT, level TEXT, message TEXT);
`);"""

new_block = """  CREATE TABLE IF NOT EXISTS log (timestamp TEXT, level TEXT, message TEXT);
  CREATE TABLE IF NOT EXISTS weather_forecast (
    date TEXT PRIMARY KEY,
    temp_min REAL,
    temp_max REAL,
    weather_main TEXT,
    weather_desc TEXT,
    pop REAL,
    humidity INTEGER,
    updated_at TEXT
  );
`);"""

if old_block in content:
    new_content = content.replace(old_block, new_block)
    with open(path, 'w') as f:
        f.write(new_content)
    print("Patched successfully.")
else:
    print("Block not found, maybe already patched?")
