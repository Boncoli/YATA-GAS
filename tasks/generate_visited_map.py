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

def get_visited_prefectures(tracks, geo_data):
    visited = set()
    # 全ての軌跡をチェック
    for track_id, path_data_str in tracks:
        path = json.loads(path_data_str)
        # 10ポイントごとに間引いてチェック（1秒1点の場合、約10秒間隔）
        # 精度と速度のバランスを最適化
        sampled_path = path[::10]
        # 念のため、最後の一点も追加
        if len(path) % 10 != 1:
            sampled_path.append(path[-1])

        if len(visited) >= 47: break
        
        for lat, lng, _ in sampled_path:
            for feature in geo_data['features']:
                pref_name = feature['properties']['nam_ja']
                if pref_name in visited:
                    continue
                
                geometry = feature['geometry']
                polygons = []
                if geometry['type'] == 'Polygon':
                    polygons = [geometry['coordinates'][0]]
                elif geometry['type'] == 'MultiPolygon':
                    polygons = [p[0] for p in geometry['coordinates']]
                
                for poly in polygons:
                    if is_inside((lng, lat), poly):
                        visited.add(pref_name)
                        print(f"  -> New discovery in track {track_id}: {pref_name}")
                        break
            if len(visited) >= 47: break
    return visited

def main():
    print("Generating visited map...")
    
    # データの読み込み
    with open(GEOJSON_PATH, 'r', encoding='utf-8') as f:
        geo_data = json.load(f)
    
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("SELECT id, path_data FROM drive_tracks")
    tracks = cursor.fetchall()
    
    visited_prefs = get_visited_prefectures(tracks, geo_data)
    print(f"Visited Prefectures: {len(visited_prefs)} ({', '.join(visited_prefs)})")
    
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
    for _, path_data_str in tracks:
        path = json.loads(path_data_str)
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
