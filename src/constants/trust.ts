import type { Trust } from '../types'

/**
 * ゴールドを内包するハイブリッドファンドの公式エクスポージャー情報（UI表示用、実効GOLD集計には未反映）
 * navGoldExposure: 純資産総額比の金エクスポージャー（例 1.0 = 100%相当）
 * grossGoldShare: 総エクスポージャー200%内の金の割合（例 0.5 = 50%）
 * 出典: 各ファンドの交付目論見書（公式確認済み）
 */
export const EMBEDDED_GOLD_EXPOSURE: Readonly<Record<string, { navGoldExposure: number; grossGoldShare: number }>> = {
  sp500gp: { navGoldExposure: 1.0, grossGoldShare: 0.5 },
  nq100gp: { navGoldExposure: 1.0, grossGoldShare: 0.5 },
}

/**
 * SBIの保有証券CSVに表示される公開上の商品正式名称。
 *
 * `Trust.abbr` はUI表示・検索補助であり、保有資産の金銭的identityには使わない。
 * aliasは同一商品が複数口座に存在する場合は各idへ同じ名称を登録し、CSV sectionの
 * accountHintとの組み合わせで一意に解決する。Trust本体へ混ぜないのは、runtime-onlyの
 * import metadataをcanonical persistence payloadへ流入させないため。
 */
export const TRUST_SBI_CSV_ALIASES: Readonly<Record<string, readonly string[]>> = {
  nk225_sbi: ['SBI・iシェアーズ・日経225インデックス・ファンド'],
  jpndiv: ['SMT 日本株配当貴族インデックス・オープン'],
  sp500_sbi: ['SBI・V・S&P500インデックス・ファンド'],
  sp500_nisa: ['SBI・V・S&P500インデックス・ファンド'],
  sp500_tsumi: ['SBI・V・S&P500インデックス・ファンド'],
  fang_toku: ['iFreeNEXT FANG+インデックス'],
  fang_nisa_g: ['iFreeNEXT FANG+インデックス'],
  fang_tsumi: ['iFreeNEXT FANG+インデックス'],
  sp500gp: ['Tracers S&P500ゴールドプラス'],
  nq100gp: ['Tracers NASDAQ100ゴールドプラス'],
  us_reit: ['eMAXIS Slim 先進国リートインデックス（除く日本）'],
  usdiv: ['Tracers S&P500配当貴族インデックス（米国株式）'],
  usdiv_nisa: ['Tracers S&P500配当貴族インデックス（米国株式）'],
  gold_mufg: ['三菱UFJ 純金ファンド'],
  acwi: ['eMAXIS Slim 全世界株式（オール・カントリー）'],
  acwi_tsumi: ['eMAXIS Slim 全世界株式（オール・カントリー）'],
  mega10: ['ニッセイ・S米国グロース株式メガ10インデックスファンド＜購入・換金手数料なし＞'],
  gold_sbi: ['SBI・iシェアーズ・ゴールドファンド（為替ヘッジなし）'],
  nq100_nisa: ['SBI NASDAQ100インデックス・ファンド'],
  nikkei_semi: ['eMAXIS 日経半導体株インデックス'],
}

// P0-PRIVACY-HOTFIX: eval/pnlPct/dayPct（個人の実保有状態）はCSV full-sync /
// localStorage / snapshotがsource of truthであり、静的fallbackとして具体的な
// 評価額・損益率を持たせない（未取込端末では一律0）。id/name/abbr/account/policy/
// cost/mu/sigmaはファンド自体のregistry metadata（accountはCSV取込時の同名複数
// account fund一意特定に使われるmatching identityのため維持）。
export const INITIAL_TRUST: Trust[] = [
  { id:'nk225_sbi',   name:'SBI 日経225',                        abbr:'日経225',      account:'特定',    policy:'JAPAN_SHORTTERM',
    eval:0, pnlPct:0, dayPct:0, cost:0.176,  mu:0.12, sigma:0.16, score:0, signal:'HOLD', ev:0, decision:'HOLD' },
  { id:'4x3bull',     name:'SBI 4.3ブル',                        abbr:'4.3ブル',      account:'特定',    policy:'JAPAN_SHORTTERM',
    eval:0, pnlPct:0, dayPct:0, cost:1.80,   mu:0.00, sigma:0.65, score:0, signal:'HOLD', ev:0, decision:'HOLD' },
  { id:'jpndiv',      name:'SMT 日本株配当貴族',                  abbr:'日株配当',     account:'特定',    policy:'JAPAN_SHORTTERM',
    eval:0, pnlPct:0, dayPct:0, cost:0.55,   mu:0.09, sigma:0.15, score:0, signal:'HOLD', ev:0, decision:'HOLD' },
  { id:'sp500_sbi',   name:'SBI V S&P500',                       abbr:'S&P500',       account:'特定',    policy:'OVERSEAS_LONGTERM',
    eval:0, pnlPct:0, dayPct:0, cost:0.0638, mu:0.14, sigma:0.17, score:0, signal:'HOLD',  ev:0, decision:'HOLD' },
  { id:'fang_toku',   name:'iFreeNEXT FANG+',                    abbr:'FANG+(特定)',   account:'特定',    policy:'OVERSEAS_LONGTERM',
    eval:0, pnlPct:0, dayPct:0, cost:0.7755, mu:0.22, sigma:0.28, score:0, signal:'HOLD',  ev:0, decision:'HOLD' },
  { id:'sp500gp',     name:'Tracers S&P500ゴールドプラス',        abbr:'S&P+Gold',     account:'特定',    policy:'OVERSEAS_LONGTERM',
    eval:0, pnlPct:0, dayPct:0, cost:0.275,  mu:0.13, sigma:0.18, score:0, signal:'HOLD',  ev:0, decision:'HOLD' },
  { id:'nq100gp',     name:'Tracers NASDAQ100ゴールドプラス',     abbr:'NQ+Gold',      account:'特定',    policy:'OVERSEAS_LONGTERM',
    eval:0, pnlPct:0, dayPct:0, cost:0.33,   mu:0.10, sigma:0.22, score:0, signal:'HOLD',  ev:0, decision:'HOLD' },
  { id:'us_reit',     name:'eMAXIS Slim 先進国REIT',              abbr:'先進国REIT',   account:'特定',    policy:'OVERSEAS_LONGTERM',
    eval:0, pnlPct:0, dayPct:0, cost:0.22,   mu:0.09, sigma:0.20, score:0, signal:'HOLD',  ev:0, decision:'HOLD' },
  { id:'usdiv',       name:'Tracers S&P500配当貴族（特定）',      abbr:'米配当(特)',   account:'特定',    policy:'OVERSEAS_LONGTERM',
    eval:0, pnlPct:0, dayPct:0, cost:0.15,   mu:0.10, sigma:0.14, score:0, signal:'HOLD',  ev:0, decision:'HOLD' },
  { id:'gold_mufg',   name:'三菱UFJ 純金ファンド',                abbr:'純金',         account:'NISA成長', policy:'GOLD',
    eval:0, pnlPct:0, dayPct:0, cost:0.55,   mu:0.07, sigma:0.14, score:0, signal:'HOLD',  ev:0, decision:'HOLD' },
  { id:'usdiv_nisa',  name:'Tracers S&P500配当貴族（NISA）',      abbr:'米配当(N)',    account:'NISA成長', policy:'OVERSEAS_LONGTERM',
    eval:0, pnlPct:0, dayPct:0, cost:0.15,   mu:0.10, sigma:0.14, score:0, signal:'HOLD',  ev:0, decision:'HOLD' },
  { id:'acwi',        name:'eMAXIS Slim 全世界株式',              abbr:'オルカン',     account:'NISA成長', policy:'OVERSEAS_LONGTERM',
    eval:0, pnlPct:0, dayPct:0, cost:0.05775,mu:0.12, sigma:0.16, score:0, signal:'HOLD',  ev:0, decision:'HOLD' },
  { id:'sp500_nisa',  name:'SBI V S&P500（NISA）',                abbr:'S&P500(N)',    account:'NISA成長', policy:'OVERSEAS_LONGTERM',
    eval:0, pnlPct:0, dayPct:0, cost:0.0638, mu:0.14, sigma:0.17, score:0, signal:'HOLD',  ev:0, decision:'HOLD' },
  { id:'mega10',      name:'ニッセイS米国グロースMEGA10',          abbr:'MEGA10',       account:'NISA成長', policy:'OVERSEAS_LONGTERM',
    eval:0, pnlPct:0, dayPct:0, cost:0.2145, mu:0.18, sigma:0.25, score:0, signal:'HOLD',  ev:0, decision:'HOLD' },
  { id:'fang_nisa_g', name:'iFreeNEXT FANG+（NISA成長）',         abbr:'FANG+(N成)',   account:'NISA成長', policy:'OVERSEAS_LONGTERM',
    eval:0, pnlPct:0, dayPct:0, cost:0.7755, mu:0.22, sigma:0.28, score:0, signal:'HOLD',  ev:0, decision:'HOLD' },
  { id:'gold_sbi',    name:'SBI ゴールドファンド',                 abbr:'Goldヘッジなし',account:'NISA成長',policy:'GOLD',
    eval:0, pnlPct:0, dayPct:0, cost:0.44,   mu:0.07, sigma:0.14, score:0, signal:'HOLD',  ev:0, decision:'HOLD' },
  { id:'sp500_tsumi', name:'SBI V S&P500（NISA積立）',            abbr:'S&P500(積)',   account:'NISA積立', policy:'OVERSEAS_LONGTERM',
    eval:0, pnlPct:0, dayPct:0, cost:0.0638, mu:0.14, sigma:0.17, score:0, signal:'HOLD',  ev:0, decision:'HOLD' },
  { id:'fang_tsumi',  name:'iFreeNEXT FANG+（NISA積立）',         abbr:'FANG+(積)',    account:'NISA積立', policy:'OVERSEAS_LONGTERM',
    eval:0, pnlPct:0, dayPct:0, cost:0.7755, mu:0.22, sigma:0.28, score:0, signal:'HOLD',  ev:0, decision:'HOLD' },
  { id:'acwi_tsumi',  name:'eMAXIS Slim 全世界株式（NISA積立）', abbr:'オルカン(積)', account:'NISA積立', policy:'OVERSEAS_LONGTERM',
    eval:0,       pnlPct:0,      dayPct:0,     cost:0.05775,mu:0.12, sigma:0.16, score:0, signal:'HOLD',  ev:0, decision:'HOLD' },
  { id:'nq100_nisa',  name:'SBI NASDAQ100インデックス（NISA成長）',abbr:'NQ100(N成)', account:'NISA成長', policy:'OVERSEAS_LONGTERM',
    eval:0,       pnlPct:0,      dayPct:0,     cost:0.1022, mu:0.18, sigma:0.22, score:0, signal:'HOLD',  ev:0, decision:'HOLD' },
  { id:'nikkei_semi', name:'eMAXIS 日経半導体株インデックス',     abbr:'日経半導体',  account:'特定',    policy:'JAPAN_SHORTTERM',
    eval:0,       pnlPct:0,      dayPct:0,     cost:0.33,   mu:0.15, sigma:0.28, score:0, signal:'HOLD', ev:0, decision:'HOLD' },
]
