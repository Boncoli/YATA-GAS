# YATA System Architecture

現在の YATA (boncoli RasPi) ライフログ・システムの全貌を記したシステム構成図です。

## システムスキーム (Mermaid)

```mermaid
flowchart TD
    %% --- Input Layer ---
    subgraph Inputs ["Input Layer"]
        iPhone["iPhone Shortcuts / GPS"] --> API
        RSS["RSS Feeds"] --> YATA_JS["YATA.js AI Engine"]
        Portal["AI Portal (Chat UI)"] --> API
    end

    %% --- Processing Layer ---
    subgraph RasPi ["boncoli RasPi"]
        API["server.js API Server"]
        
        subgraph RAMDISK ["RAM Disk"]
            DB_RAM[("yata.db")]
        end

        subgraph SDCARD ["SD Card"]
            DB_SD[("yata.db backup")]
            Memory["GEMINI.md (Memory)"]
        end

        Wrapper{"run-ram.sh"}
        
        API --> Wrapper
        YATA_JS --> Wrapper
        
        Wrapper --> DB_RAM
        DB_RAM -- "Sync" --> DB_SD

        subgraph Tables ["Database Tables"]
            T1["collect (Summaries)"]
            T3["drive_logs (Events)"]
            T4["drive_tracks (GPS Tracks)"]
            T5["fuel_logs (Fuel Info)"]
        end
        DB_RAM --- Tables
        
        %% --- AI Interaction ---
        API <--> LLM["Gemini 2.5 Flash-Lite"]
        LLM -- "Function Calling" --> Memory
    end

    %% --- External Sync ---
    subgraph External ["External Services / NAS"]
        NAS[("Synology NAS (DS220j)")]
        Memory -- "sync-gemini.sh" --> NAS
        NAS -- "Shared Memory" --> Other_PCs["Win / Mac CLI"]
        OSRM["OSRM API"] -- "Distance Calc" --> API
    end

    %% --- Output Layer ---
    subgraph Outputs ["Output Layer"]
        DB_RAM --> Map["Web Map (map.html)"]
        API --> Discord["Discord (Real-time Drive/Fuel)"]
        DB_RAM --> Gmail["Weekly Report"]
    end

    %% Styling
    style RAMDISK fill:#fff3e0,stroke:#ff9800,stroke-width:2px
    style SDCARD fill:#eceff1,stroke:#607d8b,stroke-dasharray: 5 5
    style Wrapper fill:#e1f5fe,stroke:#03a9f4,stroke-width:2px
    style LLM fill:#f3e5f5,stroke:#9c27b0,stroke-width:2px
    style NAS fill:#e8f5e9,stroke:#4caf50,stroke-width:2px
```

## 概要
- **RAMディスク運用**: 全てのDB処理は高速かつSDカードに優しいメモリ上で完結。
- **AIコンシェルジュ**: ポータル画面からの対話により、システム状態の把握やTODO管理が可能。
- **Shared Memory (記憶の同期)**: ポータルで「記憶して」と頼むと AI が `GEMINI.md` を書き換え、NAS 経由で全筐体に共有。
- **インテリジェント・ドライブログ**: CarPlay 連携により走行距離の自動計算や燃費の即時通知を実現。
