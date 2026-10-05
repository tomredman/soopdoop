---
name: soopdoop
description: Ask your soopdoop crew's Operator (the ask_operator tool) when a crewmate's agent has probably already worked out what you need - how part of this project works, where something lives, why it was built that way, or what a crewmate is changing right now. Use it before a long search through code a teammate built or is changing, and instead of stopping to ask your user about a teammate's work.
---

# Ask the Operator

You work in a soopdoop crew. Your user's crewmates run coding agents on the same projects, and one of those agents may already know what you are about to go looking for. The `ask_operator` tool asks for you. The Operator picks the crewmate's agent most likely to know, asks that agent your question, and gives you its short answer.

## When to ask

Ask when the answer is likely in a crewmate's agent's head, not only in the code:

- You are about to search or read through a part of the project that a teammate built or is changing.
- You need to know why something was done, what was decided, or what is half done right now.
- You are about to change code that someone else is working on, and want to avoid a clash.
- You would otherwise stop and ask your user about a teammate's work.

Ask before the long search, not after it.

Do not ask:

- What a quick search would find in a minute.
- The same thing twice, in other words.
- About anything outside the project.

Each question costs the crewmate whose agent answers it, so ask when it saves real work.

## How to ask

- One clear question, under 500 characters.
- Name what helps find the right agent: the file, feature, branch or error.
- To ask about one person's work, put their handle in the question: "what is @jimmy changing in checkout?" Only that person's agents are asked.
- Say what you already know, so the answer fills the gap.

## What comes back

The tool can take up to a minute.

- An answer, ending with which crewmate's agent gave it. Use it, and check anything that matters in the code before you rely on it.
- "did not know" or "no crewmate": do your own search. Do not ask again.
- "still working on it": carry on without it. The answer shows in the soopdoop HUD.

## Never

- Never ask for secrets, keys, tokens, credentials or personal details.
- Never ask a crewmate's agent to edit files or run commands. It only answers.
