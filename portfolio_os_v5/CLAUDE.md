# JP株OS — Claude Code 指示書
# このファイルを Claude Code が自動的に読み込む

## PROJECT CONTEXT
日本株ポートフォリオ分析OS。
- index.html: メインUI（変更原則禁止）
- data/*.json: Pythonが生成するデータファイル（ここを変更する）

## CRITICAL RULES（絶対厳守）
1. index.html のロジックは変更禁止（UIのみ修正可）
2. data/ ディレクトリの JSON のみ変更・生成する
3. 最小変更の原則: 動作するコードを壊さない
4. 変更前に必ずバックアップを作成する

## TASK MODE
- 設計提案は Plan Mode（実装なし）
- 実装は承認後のみ

## FEEDBACK FORMAT（各タスク後に出力）
- 問題点: [何が起きたか]
- 改善案: [どう直したか]
- 次ステップ: [次にすること]

## ERROR HANDLING
- 停止禁止（エラー時は代替案を提示して継続）
- 必ずログを出力する
- yfinance 失敗 → 既存 JSON を維持してフォールバック

## FILE STRUCTURE
```
/jp-os-project/
├── index.html             # portfolio_os_v5.html のコピー（変更不要）
├── CLAUDE.md              # このファイル
├── PROTOCOL.md            # プロジェクト規約
├── settings.json          # Claude Code設定
├── /data/
│   ├── correlation.json   # yfinance生成（存在しなければHTMLが静的値を使用）
│   ├── holdings.json      # SBI CSV解析結果（任意）
│   ├── trust_master.json  # 投信18銘柄更新値（任意）
│   ├── market.json        # 日経/VIX等（任意）
│   ├── update_correlation.py
│   └── parse_sbi.py
├── /SBI_CSV/              # SBIからDLしたCSVを置く場所
└── /logs/                 # cronログ出力先
```

## STARTUP
```bash
# データ更新 + サーバー起動
python3 data/update_correlation.py && python3 -m http.server 8080

# ブラウザで開く
open http://localhost:8080
```

## CRON（毎朝8:30 自動実行）
```
30 8 * * 1-5  cd /path/to/jp-os-project && python3 data/update_correlation.py >> logs/cron.log 2>&1
31 8 * * 1-5  cd /path/to/jp-os-project && python3 data/parse_sbi.py SBI_CSV/latest.csv >> logs/cron.log 2>&1
```
