#!/bin/bash
# JP株OS — cron自動化セットアップスクリプト
# 使用: bash cron_setup.sh

PROJECT_DIR="/Users/ryo/Downloads/Claude"
PYTHON="/Library/Developer/CommandLineTools/usr/bin/python3"

echo "=== JP株OS cron セットアップ ==="
echo "プロジェクト: $PROJECT_DIR"
echo "Python: $PYTHON"
echo ""

# 既存のcrontabを保存
TMPFILE=$(mktemp)
crontab -l 2>/dev/null > "$TMPFILE"

# 重複チェック
if grep -q "jp-os-project\|update_correlation\|parse_sbi" "$TMPFILE"; then
    echo "⚠ JP株OS の cron エントリが既に存在します:"
    grep "update_correlation\|parse_sbi" "$TMPFILE"
    echo ""
    read -p "上書きしますか？ [y/N]: " ans
    if [[ "$ans" != "y" && "$ans" != "Y" ]]; then
        echo "キャンセルしました。"
        rm "$TMPFILE"
        exit 0
    fi
    # 既存エントリを削除
    grep -v "update_correlation\|parse_sbi" "$TMPFILE" > "${TMPFILE}.new"
    mv "${TMPFILE}.new" "$TMPFILE"
fi

# cronエントリを追加（平日8:30/8:31）
cat >> "$TMPFILE" << CRONEOF

# JP株OS — 毎朝8:30 自動更新（平日のみ）
30 8 * * 1-5 cd $PROJECT_DIR && $PYTHON data/update_correlation.py >> logs/cron.log 2>&1
31 8 * * 1-5 cd $PROJECT_DIR && $PYTHON data/parse_sbi.py SBI_CSV/latest.csv >> logs/cron.log 2>&1
CRONEOF

# crontabに適用
crontab "$TMPFILE"
rm "$TMPFILE"

echo "✓ cron設定完了:"
echo ""
crontab -l | grep -A2 "JP株OS"
echo ""
echo "確認コマンド: crontab -l"
echo "ログ確認:     tail -f $PROJECT_DIR/logs/cron.log"
