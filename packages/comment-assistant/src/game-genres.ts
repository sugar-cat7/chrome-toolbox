import type { StreamGenre } from '@chrome-toolbox/extension-core';

/**
 * Commonly streamed games and Twitch categories by genre (R63, Task G2 step 4). Each entry
 * lists the names the platforms show for one game: YouTube's game card in English and in
 * Japanese (the card follows the page language and often names the series, `Overwatch`, `Call
 * of Duty`) and Twitch's category slug (`/directory/category/<slug>`) where it reads otherwise.
 * Seen on YouTube watch pages and Twitch directory pages on 2026-11-05. A name matches after
 * NFKC, lower case and without anything but letters and digits (`gameKey`), so `Apex Legends`
 * also matches the slug `apex-legends`. Twitch's own categories without a game (Just Chatting,
 * Music …) are here too; YouTube shows no card for them.
 */
export const GAME_GENRES = [
  // FPS, battle royale, PvP and fighting games.
  { genre: 'fps', names: ['Apex Legends', 'エーペックスレジェンズ'] },
  { genre: 'fps', names: ['VALORANT'] },
  { genre: 'fps', names: ['Fortnite', 'フォートナイト'] },
  { genre: 'fps', names: ['Overwatch', 'オーバーウォッチ', 'overwatch-2'] },
  { genre: 'fps', names: ['Call of Duty', 'call-of-duty-warzone'] },
  { genre: 'fps', names: ['Escape from Tarkov'] },
  {
    genre: 'fps',
    names: [
      'Counter-Strike: Global Offensive',
      'カウンターストライク：グローバルオフェンシブ',
      'counter-strike',
    ],
  },
  { genre: 'fps', names: ['PUBG: Battlegrounds', 'PUBG'] },
  { genre: 'fps', names: ["Tom Clancy's Rainbow Six Siege", 'レインボーシックス シージ'] },
  { genre: 'fps', names: ['Tekken 8', '鉄拳8'] },
  { genre: 'fps', names: ['Street Fighter 6', 'ストリートファイター6'] },
  {
    genre: 'fps',
    names: ['Super Smash Bros. Ultimate', '大乱闘スマッシュブラザーズ SPECIAL'],
  },
  { genre: 'fps', names: ['Marvel Rivals'] },
  // Asymmetric PvP: stream sniping and ghosting matter more than its horror.
  { genre: 'fps', names: ['Dead by Daylight'] },
  { genre: 'fps', names: ['Splatoon 3', 'スプラトゥーン3'] },
  { genre: 'fps', names: ['League of Legends'] },
  { genre: 'fps', names: ['Rocket League', 'ロケットリーグ'] },
  { genre: 'fps', names: ['Dota 2'] },
  { genre: 'fps', names: ['Strinova'] },
  { genre: 'fps', names: ['Mario Kart World', 'マリオカート ワールド'] },
  // Story games, RPGs and adventures.
  { genre: 'story', names: ['Elden Ring'] },
  { genre: 'story', names: ['Elden Ring Nightreign'] },
  { genre: 'story', names: ['Genshin Impact', '原神'] },
  { genre: 'story', names: ['Honkai: Star Rail', '崩壊:スターレイル'] },
  { genre: 'story', names: ['Zenless Zone Zero', 'ゼンレスゾーンゼロ'] },
  {
    genre: 'story',
    names: ['Final Fantasy XIV', 'ファイナルファンタジーXIV', 'final-fantasy-xiv-online'],
  },
  { genre: 'story', names: ['Undertale'] },
  { genre: 'story', names: ['Deltarune'] },
  { genre: 'story', names: ['Persona 5 Royal'] },
  {
    genre: 'story',
    names: [
      'Pokémon Scarlet and Violet',
      'ポケットモンスター スカーレット・バイオレット',
      'pokemon-scarlet-violet',
    ],
  },
  { genre: 'story', names: ['Pokémon Legends: Z-A', 'pokemon-legends-z'] },
  {
    genre: 'story',
    names: [
      'The Legend of Zelda: Tears of the Kingdom',
      'ゼルダの伝説 ティアーズ オブ ザ キングダム',
    ],
  },
  { genre: 'story', names: ["Baldur's Gate 3", 'バルダーズ・ゲート3'] },
  { genre: 'story', names: ['Clair Obscur: Expedition 33'] },
  { genre: 'story', names: ['Monster Hunter Wilds', 'モンスターハンターワイルズ'] },
  { genre: 'story', names: ['Hollow Knight: Silksong'] },
  { genre: 'story', names: ['Cyberpunk 2077'] },
  { genre: 'story', names: ['Ghost of Yōtei', 'ghost-of-yotei'] },
  { genre: 'story', names: ['Death Stranding 2: On the Beach', 'death-stranding-2'] },
  { genre: 'story', names: ['Black Myth: Wukong', '黒神話:悟空'] },
  { genre: 'story', names: ['Red Dead Redemption 2', 'レッド・デッド・リデンプション 2'] },
  // Unprompted instructions are the classic NG of a sandbox stream.
  { genre: 'story', names: ['Minecraft'] },
  { genre: 'story', names: ['Stardew Valley'] },
  // Horror games.
  { genre: 'horror', names: ['Phasmophobia'] },
  { genre: 'horror', names: ['Lethal Company'] },
  { genre: 'horror', names: ['R.E.P.O.'] },
  {
    genre: 'horror',
    names: ['Resident Evil 9', 'バイオハザード レクイエム', 'resident-evil-requiem'],
  },
  { genre: 'horror', names: ['Resident Evil 4', 'バイオハザード4'] },
  { genre: 'horror', names: ['Silent Hill f'] },
  { genre: 'horror', names: ['The Exit 8', '8番出口'] },
  { genre: 'horror', names: ['Content Warning'] },
  // Puzzle games and games played for a run.
  { genre: 'puzzle_rta', names: ['Only Up!'] },
  { genre: 'puzzle_rta', names: ['Jump King'] },
  { genre: 'puzzle_rta', names: ['Chained Together'] },
  { genre: 'puzzle_rta', names: ['Getting Over It with Bennett Foddy'] },
  { genre: 'puzzle_rta', names: ['Tetris 99'] },
  { genre: 'puzzle_rta', names: ['Portal 2'] },
  { genre: 'puzzle_rta', names: ['Baba Is You'] },
  // Mahjong, board and card games.
  { genre: 'board', names: ['Mahjong Soul', '雀魂 -じゃんたま-'] },
  { genre: 'board', names: ['Shadowverse: Worlds Beyond'] },
  { genre: 'board', names: ['Hearthstone', 'ハースストーン'] },
  { genre: 'board', names: ['Yu-Gi-Oh! Master Duel', '遊戯王マスターデュエル'] },
  {
    genre: 'board',
    names: ['Pokémon Trading Card Game Pocket', 'pokemon-trading-card-game-pocket'],
  },
  { genre: 'board', names: ['Balatro'] },
  {
    genre: 'board',
    names: [
      '桃太郎電鉄2 〜あなたの町も きっとある〜',
      'momotaro-dentetsu-2-anata-no-machi-mo-kitto-aru',
    ],
  },
  { genre: 'board', names: ['Super Mario Party Jamboree'] },
  { genre: 'board', names: ['Chess'] },
  { genre: 'board', names: ['Poker'] },
  { genre: 'board', names: ['Shogi'] },
  // Social deduction games.
  { genre: 'deduction', names: ['Among Us'] },
  { genre: 'deduction', names: ['Goose Goose Duck'] },
  { genre: 'deduction', names: ["Liar's Bar"] },
  { genre: 'deduction', names: ['Project Winter'] },
  // Twitch's categories without a game.
  { genre: 'chat', names: ['Just Chatting'] },
  { genre: 'chat', names: ['talk-shows-and-podcasts'] },
  { genre: 'singing', names: ['Music'] },
  { genre: 'sports_viewing', names: ['Sports'] },
  { genre: 'watchalong', names: ['Watch Parties'] },
] as const satisfies readonly Readonly<{ genre: StreamGenre; names: readonly string[] }>[];
