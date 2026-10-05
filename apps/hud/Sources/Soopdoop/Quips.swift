// ABOUTME: What the HUD says when you get flicked, superflicked or caught: one line at random each time. They show in the
// ABOUTME: green toast at the bottom of the HUD, and in the notification while the HUD is hidden.
enum Quips {
    static let flicked = [
        "You gonna just take that?",
        "Bruh. Ouch.",
        "Rude.",
        "Are we fighting now?",
        "That one had feelings in it.",
        "Hey! HEY.",
        "Bold move.",
        "Somebody's bored.",
        "That's going on their record.",
        "Ow, my pixels.",
        "Flick back. Do it.",
        "They didn't even say sorry.",
        "Disrespectful.",
        "Oh, it's on.",
    ]

    static let superflicked = [
        "Bruh. OUCH.",
        "That's gotta hurt.",
        "Daylight robbery.",
        "Call the cops.",
        "You gonna let that slide?",
        "Revenge is a flick away.",
    ]

    static let caught = [
        "What a shame.",
        "Skill issue.",
        "Embarrassing.",
        "They saw that coming.",
        "Too slow, too bad.",
        "Oof.",
    ]

    static func pick(_ lines: [String]) -> String {
        lines.randomElement() ?? "Ouch."
    }
}
