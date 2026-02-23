import sqlite3
import json
import matplotlib.pyplot as plt
from matplotlib.patches import Polygon
from matplotlib.collections import PatchCollection
import os

# 設定
DB_PATH = os.environ.get("DB_PATH", "yata.db")
GEOJSON_PATH = "modules/data/japan.geojson"
OUTPUT_PATH = "local_public/visited_map.png"
YATA_GREEN = "#00e676"
UNVISITED_GRAY = "#eeeeee"
TRACK_COLOR = "#333333"

def is_inside(point, poly):
    """Ray-casting algorithm for point-in-polygon check."""
    px, py = point
    n = len(poly)
    inside = False
    p1x, p1y = poly[0]
    for i in range(n + 1):
        p2x, p2y = poly[i % n]
        if py > min(p1y, p2y):
            if py <= max(p1y, p2y):
                if px <= max(p1x, p2x):
                    if p1y != p2y:
                        xinters = (py - p1y) * (p2x - p1x) / (p2y - p1y) + p1x
                    if p1x == p2x or px <= xinters:
                        inside = not inside
        p1x, p1y = p2x, p2y
    return inside

def get_already_visited(conn):
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS visited_prefectures (
            name TEXT PRIMARY KEY,
            first_visited_at TEXT
        )
    """)
    cursor.execute("SELECT name FROM visited_prefectures")
    return set(row[0] for row in cursor.fetchall())

def save_new_visited(conn, new_visited):
    if not new_visited: return
    cursor = conn.cursor()
    now = sqlite3.connect(DB_PATH).execute("SELECT datetime('now', 'localtime')").fetchone()[0]
    for pref in new_visited:
        cursor.execute("INSERT OR IGNORE INTO visited_prefectures (name, first_visited_at) VALUES (?, ?)", (pref, now))
    conn.commit()

def get_visited_prefectures(conn, geo_data):
    # すでに訪問済みの県をDBから取得
    visited = get_already_visited(conn)
    if len(visited) >= 47: return visited

    cursor = conn.cursor()
    # まだ訪問していない県を特定
    all_prefs = {f['properties']['nam_ja'] for f in geo_data['features']}
    not_visited_prefs = all_prefs - visited
    
    # 未訪問県がある場合のみ、最新の軌跡をチェック
    # (本当は全件チェックが必要だが、一度DBに溜まれば以後は新規分だけでよくなる)
    # 初回は全件スキャン、2回目以降は未訪問県のみを対象にする
    cursor.execute("SELECT id, path_data FROM drive_tracks")
    tracks = cursor.fetchall()
    
    newly_found = set()
    for track_id, path_data_str in tracks:
        path = json.loads(path_data_str)
        # 精度と速度のバランス (1/2間引き)
        sampled_path = path[::2]
        if len(path) % 2 != 1: sampled_path.append(path[-1])

        for lat, lng, _ in sampled_path:
            # まだ見つかっていない県だけをGeoJSONと照合
            remaining_to_find = not_visited_prefs - newly_found
            if not remaining_to_find: break
            
            for feature in geo_data['features']:
                pref_name = feature['properties']['nam_ja']
                if pref_name in visited or pref_name in newly_found:
                    continue
                
                geometry = feature['geometry']
                polygons = []
                if geometry['type'] == 'Polygon':
                    polygons = [geometry['coordinates'][0]]
                elif geometry['type'] == 'MultiPolygon':
                    polygons = [p[0] for p in geometry['coordinates']]
                
                for poly in polygons:
                    if is_inside((lng, lat), poly):
                        newly_found.add(pref_name)
                        print(f"  -> New discovery in track {track_id}: {pref_name}")
                        break
        if not (not_visited_prefs - newly_found): break
    
    save_new_visited(conn, newly_found)
    return visited | newly_found

def main():
    print("Generating visited map...")
    
    # データの読み込み
    with open(GEOJSON_PATH, 'r', encoding='utf-8') as f:
        geo_data = json.load(f)
    
    conn = sqlite3.connect(DB_PATH)
    
    visited_prefs = get_visited_prefectures(conn, geo_data)
    print(f"Visited Prefectures: {len(visited_prefs)}")
    
    # 統計データの保存
    stats = {
        "count": len(visited_prefs),
        "total": 47,
        "percent": round(len(visited_prefs) / 47 * 100, 1),
        "list": sorted(list(visited_prefs))
    }
    with open("local_public/visited_stats.json", "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=2)

    # 描画設定
    fig, ax = plt.subplots(figsize=(12, 12))
    ax.set_aspect('equal')
    
    # 都道府県の描画
    for feature in geo_data['features']:
        pref_name = feature['properties']['nam_ja']
        color = YATA_GREEN if pref_name in visited_prefs else UNVISITED_GRAY
        
        geometry = feature['geometry']
        if geometry['type'] == 'Polygon':
            coords_list = [geometry['coordinates'][0]]
        elif geometry['type'] == 'MultiPolygon':
            coords_list = [p[0] for p in geometry['coordinates']]
        
        for coords in coords_list:
            poly = Polygon(coords, facecolor=color, edgecolor='#ffffff', linewidth=0.5)
            ax.add_patch(poly)
            
    # 軌跡の描画
    cursor = conn.cursor()
    cursor.execute("SELECT path_data FROM drive_tracks")
    for row in cursor:
        path = json.loads(row[0])
        lngs = [p[1] for p in path]
        lats = [p[0] for p in path]
        ax.plot(lngs, lats, color=TRACK_COLOR, linewidth=0.3, alpha=0.6)

    # 範囲調整（日本全土が入るように）
    ax.set_xlim(128, 146)
    ax.set_ylim(30, 46)
    ax.axis('off')
    
    plt.title(f"YATA Travel Map: {len(visited_prefs)} Prefectures Visited", fontsize=15, pad=20)
    plt.savefig(OUTPUT_PATH, dpi=150, bbox_inches='tight', transparent=True)
    plt.close()
    
    print(f"Map saved to {OUTPUT_PATH}")
    conn.close()

if __name__ == "__main__":
    main()
