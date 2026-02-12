# YATA System Architecture

現在の YATA (boncoli RasPi) ライフログ・システムの全貌を記したシステム構成図です。

## システムスキーム (Mermaid)

```mermaid
flowchart TD
    %% --- Input Layer ---
    subgraph Inputs ["Input Layer"]
        iPhone["iPhone Shortcuts"] --> API
        RSS["RSS Feeds"] --> YATA_JS["YATA.js AI Engine"]
        Remo["Nature Remo"] --> Remo_Module["get-remo.js"]
    end

    %% --- Processing Layer ---
    subgraph RasPi ["boncoli RasPi"]
        API["server.js API Server"]
        
        subgraph RAMDISK ["RAM Disk"]
            DB_RAM[("yata.db")]
        end

        subgraph SDCARD ["SD Card"]
            DB_SD[("yata.db backup")]
        end

        Wrapper{"run-ram.sh"}
        
        API --> Wrapper
        YATA_JS --> Wrapper
        Remo_Module --> Wrapper
        
        Wrapper --> DB_RAM
        DB_RAM -- "Sync" --> DB_SD

        subgraph Tables ["Database Tables"]
            T1["collect (Summaries)"]
            T2["history (Discord Logs)"]
            T3["drive_logs (Events)"]
            T4["drive_tracks (GPS Tracks)"]
            T5["fuel_logs (Fuel Info)"]
        end
        DB_RAM --- Tables
    end

    %% --- Output Layer ---
    subgraph Outputs ["Output Layer"]
        DB_RAM --> Map["Web Map (map.html)"]
        DB_RAM --> Discord["Discord Digest"]
        DB_RAM --> Gmail["Weekly Report"]
        DB_RAM --> Dash["Dashboard / Grafana"]
    end

    %% Styling
    style RAMDISK fill:#fff3e0,stroke:#ff9800,stroke-width:2px
    style SDCARD fill:#eceff1,stroke:#607d8b,stroke-dasharray: 5 5
    style Wrapper fill:#e1f5fe,stroke:#03a9f4,stroke-width:2px
```

## 概要
- **RAMディスク運用**: 全てのDB処理は高速かつSDカードに優しいメモリ上で完結。
- **ハイブリッド・ログ**: CarPlayの「イベント（点）」とiPhoneの「軌跡（線）」を同一DBで管理。
- **情報の濾過**: 大量のRSS記事をAIが要約・選別し、DiscordとGmailで段階的に通知。
