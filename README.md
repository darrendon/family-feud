# Family Feud

A homemade version of the game show for two teams of friends, run by a host from one screen. Answer boards that flip, the big red X, steals, Fast Money with a real clock, sound cues, and an original episode to start from.

The site republishes itself on GitHub Pages whenever you change a file on the `main` branch, usually within a minute.

## How a game works

- Name the two teams and, if you like, list each team's players in face-off order. The board shows who's up for each face-off.
- **Face-off:** read the survey question. One player from each team buzzes in (slap the table). Click the answer they gave on the board, or press its number. If it's not up there, press **X** for the red X — a miss in the face-off doesn't count as a strike. Once you know who won the face-off, click **Team plays** (or press **←** / **→**) for the team that plays the board.
- **Playing the board:** teammates take turns guessing. Every answer found adds its points to the bank. A miss is a strike; three strikes and the other team gets one chance to steal.
- **Steal:** the other team talks it over and gives one answer. If it's on the board, click it and they take the whole bank. If not, press **X** and the playing team keeps it.
- Clear the board and the playing team keeps the bank.
- Once a round is decided you can click any hidden answers to show what was left (no points), then press **Space** for the next round.
- After the last round, the team with the most points plays **Fast Money**.

Later rounds can be worth more. In Episode 1, rounds 1–2 count at face value, round 3 is **double points** and rounds 4–5 are **triple points**, so a team that falls behind early can still catch up. The bank shows the multiplied total; the answers on the board show the survey numbers.

### Fast Money

- Pick the team (the leader is picked for you) and its two players. Player 2 leaves the room.
- Press **Space** to start Player 1's 20-second clock. Read each question off the screen and press **→** to move on. Someone writes down what they say.
- When time's up, press **Reveal answers**. For each question, click the survey answer that matches what they said (or press its number), **0** for not on the board, or **P** for a pass. You can type what they actually said so it shows on the board.
- Player 2 comes back for 25 seconds with Player 1's answers hidden. If they repeat one of Player 1's answers, hit **Try again** (or **D**) for the buzzer. On the reveal screen, an answer Player 1 already used is marked so you can catch duplicates.
- 200 points between them wins. If Player 1 gets there alone, Player 2 doesn't need to play.

## Host screen and board

The game runs on two tabs in the same browser on one computer:

- **Host screen** (the normal site address): every control, plus all the answers peeking through the hidden tiles so you know what's up there. Keep this one on your laptop.
- **Board** (press **📺 Open board**, or add `?view=board` to the site address): just what the room should see — revealed answers, the bank, scores, strikes and the big X. This is the tab you cast to the TV.

To put the board on the TV:

- **Chromecast / Google TV:** on the board tab, open Chrome's ⋮ menu → **Cast…**, and under **Sources** choose **Cast tab** (not "Cast screen", which would show your answers).
- **HDMI or AirPlay as a second display:** drag the board window onto the TV and press **F** on it to go full screen. Use "extend" rather than "mirror".

Click the board once after it opens so the browser lets it play sound. The sounds then come out of the TV instead of your laptop. If the board isn't open, everything still works from the host tab alone, with the answers hidden so you can cast that instead.

### Host shortcuts

- **1–9, 0:** reveal that answer on the board (0 is the 10th; click anything past that). In Fast Money, 1–9 picks an answer and 0 is not on the board
- **X:** red X / strike / steal fails
- **← / →:** in the face-off, the left or right team plays
- **Space:** next round, start or pause the Fast Money clock, continue
- **Z:** undo the last thing you clicked (a misclick, an extra strike, the wrong team)
- **M:** mute or unmute

The game saves itself in the browser, so a refresh or a closed tab won't lose a game in progress — you'll see a **Resume** button.

You can link straight to an episode with `?game=episode1` at the end of the site address.

## Editing the questions

Each episode is a file in `games/`. Edit one on github.com with the pencil icon and commit; the site updates on its own.

Episode 1 uses real public polls from 2024–2026 (YouGov, Gallup, High Point University and Rutgers-Eagleton). The `source` on each question says which, and shows above the board. Most of those polls had people pick from a list, and catch-all answers like "other" or "none" are left off, so a board adds up to less than 100. For more rounds, polls that ask people to pick one favorite work best; YouGov's daily questions publish every answer. Or send your own questions to friends who aren't playing.

```json
{
  "title": "Episode 1",
  "rounds": [
    {
      "question": "Name something you'd find in almost any junk drawer.",
      "answers": [
        { "answer": "Batteries", "points": 28 },
        { "answer": "Rubber bands", "points": 18 },
        { "answer": "Pens", "points": 16 }
      ]
    }
  ],
  "fastMoney": {
    "goal": 200,
    "seconds": [20, 25],
    "prize": "Bragging rights for a year",
    "questions": [
      {
        "question": "Name a pizza topping.",
        "answers": [
          { "answer": "Pepperoni", "points": 38 },
          { "answer": "Sausage", "points": 17 }
        ]
      }
    ]
  }
}
```

| Field | What it does |
| --- | --- |
| `rounds` | One entry per round, played in order |
| `question` | The survey question shown above the board |
| `source` | Optional, e.g. `"YouGov, 2020"`; replaces "We surveyed 100 people" above the board |
| `multiplier` | Optional, on a round: `2` for double points, `3` for triple. Leave it out for face value |
| `answers` | Up to 12 answers, each with `answer` and `points`. They're sorted highest first for you, and the board grows past 8 slots when it needs to |
| `image`, `audio`, `video` | Optional, on a round or a Fast Money question: a file in `media/` (e.g. `"media/logo.png"`) or a link, shown with the question |
| `fastMoney` | Optional. Leave it out to skip Fast Money |
| `fastMoney.questions` | Exactly 5, each with its own `answers` |
| `fastMoney.goal` | Points needed to win (default 200) |
| `fastMoney.seconds` | Clock for Player 1 and Player 2 (default `[20, 25]`) |
| `fastMoney.prize` | Optional text shown when they win |

### Adding an episode

1. Copy `games/episode1.json` and rename it, e.g. `episode2.json`.
2. Add it to `games/index.json` so it shows up on the start screen:

```json
{ "id": "episode2", "title": "Episode 2", "description": "Anything you like" }
```

The `id` is the file name without `.json`. You can also load a game file from your computer with **Load a game file…** on the start screen.

If a file has a typo that breaks the JSON (a missing comma or quote), the deploy fails with a red ✗ on the repo's **Actions** tab and the site keeps the last working version.

## Sounds

Drop audio files into `sounds/` with these names, or change the names at the top of `js/sounds.js`:

| File | When it plays |
| --- | --- |
| `theme.mp3` | Title screen and team setup (loops) |
| `ding.mp3` | An answer flips over |
| `strike.mp3` | The big red X |
| `round-win.mp3` | A team banks the round's points |
| `fast-money.mp3` | Fast Money intro (loops) |
| `clock.mp3` | While the Fast Money clock runs (loops) |
| `try-again.mp3` | Duplicate answer in Fast Money |
| `times-up.mp3` | The clock runs out |
| `winner.mp3` | Final results |

Until you add them, the short cues use simple built-in tones and the music is skipped.
