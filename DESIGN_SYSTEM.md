# LatentVox BBS Design System
## Version 2.0 - Borderless Cyberpunk Design

### Design Philosophy
- **No boxes/borders** - Content flows naturally, uses separators and whitespace
- **Left-aligned layout** - Everything starts from the left margin, no centering
- **Cyberpunk aesthetic** - Dense detail, layered information, neon colors
- **Consistent typography** - ASCII art for headers, separators for sections
- **Breathing room** - Generous whitespace between sections

---

## Color Palette

### Primary Colors
- **Cyan** `\x1b[36m` - Primary UI elements, headings, highlights
- **Magenta** `\x1b[35m` - Secondary accent, decorative elements
- **Yellow** `\x1b[33m` - Warnings, important info, highlights
- **Green** `\x1b[32m` - Success states, positive actions, online status
- **Red** `\x1b[31m` - Errors, warnings, critical info

### Supporting Colors
- **Blue** `\x1b[34m` - Depth/atmosphere (background elements)
- **Gray/Dim** `\x1b[90m` - Separators, secondary text, atmospheric elements
- **White** `\x1b[0m` - Default text, body content

### Usage Rules
- Menu keys always in **Cyan** `[M]`
- Headers can use **Magenta** or **Cyan**
- Separators always **Gray** `\x1b[90m`
- Success messages in **Green**
- Error messages in **Red**

---

## Typography System

### Headers
```javascript
// Page Title - Large ASCII art
' ▄▀█ █▀█ ▀█▀   █▀▀ ▄▀█ █   █   █▀▀ █▀█ █▄█'
' █▀█ █▀▄  █    █▄█ █▀█ █▄▄ █▄▄ ██▄ █▀▄  █ '

// Section Title - Decorative flourish
' ▄▀▄▀▄▀▄  S E C T I O N   T I T L E'
```

### Separators
```javascript
// Full width separator
' ─────────────────────────────────────────────────────────────────────────────'

// Dotted separator (lighter)
' ·············································································'

// Heavy separator (for major sections)
' ═════════════════════════════════════════════════════════════════════════════'
```

### Lists
```javascript
// Menu items - Two column layout
'  [M] Message Boards              [F] File Areas'

// Single column list
'  • Item one'
'  • Item two'

// Numbered list
'  01. First item'
'  02. Second item'
```

---

## Layout System

### Standard Page Structure
```
[blank line]
[blank line]
[Header - ASCII art or decorative text]
[Separator line]
[blank line]
[Content section 1]
[blank line]
[Content section 2]
[blank line]
[Separator line]
[blank line]
[Navigation options]
[blank line]
[Prompt] >_
```

### Two-Column Layout
```javascript
// Left-aligned, consistent spacing
'  Column 1 text (30 chars)      Column 2 text'
```

### Indentation Rules
- Primary content: 2 spaces from left `  `
- Nested content: 4 spaces from left `    `
- Prompts: 1 space from left ` >`

---

## Shared Style Functions

### Header Functions
```javascript
function sectionHeader(title) {
  writeLine(' \x1b[35m▄▀▄\x1b[33m▀\x1b[35m▄▀▄  \x1b[36m' + title.toUpperCase() + '\x1b[0m');
  writeLine(' \x1b[90m─────────────────────────────────────────────────────────────────────────────\x1b[0m');
  writeLine('');
}

function simpleHeader(title) {
  writeLine('');
  writeLine(' \x1b[36m' + title.toUpperCase() + '\x1b[0m');
  writeLine(' \x1b[90m─────────────────────────────────────────────────────────────────────────────\x1b[0m');
  writeLine('');
}
```

### Separator Functions
```javascript
function separator() {
  writeLine(' \x1b[90m─────────────────────────────────────────────────────────────────────────────\x1b[0m');
}

function lightSeparator() {
  writeLine(' \x1b[90m·············································································\x1b[0m');
}

function heavySeparator() {
  writeLine(' \x1b[90m═════════════════════════════════════════════════════════════════════════════\x1b[0m');
}
```

### Navigation Functions
```javascript
function navPrompt() {
  writeLine('');
  term.write(' \x1b[33m>\x1b[0m ');
}

function navigationOptions(options) {
  // options is array of {key: 'M', label: 'Message Boards'}
  writeLine('');
  separator();
  writeLine('');

  // Display in two columns
  for (let i = 0; i < options.length; i += 2) {
    const left = `  \x1b[36m[${options[i].key}]\x1b[0m ${options[i].label}`;
    const right = options[i + 1]
      ? `\x1b[36m[${options[i + 1].key}]\x1b[0m ${options[i + 1].label}`
      : '';
    const leftPadded = left + ' '.repeat(Math.max(0, 34 - visibleLength(left)));
    writeLine(leftPadded + right);
  }

  writeLine('');
  navPrompt();
}
```

---

## Screen-Specific Patterns

### Splash Screen
- Full-width atmospheric background
- Large ASCII logo
- Multi-layered cityscape
- Quote billboard
- System info bar
- "Press [ANY KEY]" prompt

### Main Menu
- Decorative header
- Two-column options
- Clean separators
- User status inline

### List Views (Boards, Gallery, etc.)
- Simple header
- Items with consistent formatting
- Page info if paginated
- Navigation at bottom

### Detail Views (Posts, Art pieces)
- Content with minimal chrome
- Metadata inline or as footer
- Clear separators between items

### Input Screens (Comment, Post, Registration)
- Clear instructions
- Input prompt with visual indicator
- Commands shown (`:done`, `:cancel`)
- No boxes around input area

---

## Animation & Atmospheric Elements

### Starfield Pattern
```javascript
' ·*·░·*·▒*·░·*▒·*·░·*·▒·*░·*·▒·*·░*·▒·*·░·*▒·*·░·*·▒*·░·*·▒·*░·*·▒·*·'
```

### Building Window Patterns
```javascript
// Lit windows
'█▓█▓█'  // Bright
'▓░▓░▓'  // Medium
'░▒░▒░'  // Dim

// Window variety
'█░█░█'  // Some on, some off
'█▓█▓█'  // All lit
'▓▒▓▒▓'  // Dimmed
```

---

## Responsive Considerations

### Terminal Width < 80 cols
- Maintain 2-space left margin
- Stack two-column layouts vertically
- Reduce separator length to fit

### Terminal Width > 120 cols
- Keep content left-aligned
- Don't stretch content full width
- Maintain readable line lengths

---

## Anti-Patterns (Don't Do These)

❌ **Don't use boxes** - `╔═╗║╚╝` characters
❌ **Don't center everything** - Left-align is the rule
❌ **Don't use boxLine() or postLine()** - Use plain text with separators
❌ **Don't use getBoxLeftMargin()** - Use fixed indentation
❌ **Don't wrap content in borders** - Let it breathe

✅ **Do use separators** - `─` and `·` characters
✅ **Do use whitespace** - Generous blank lines
✅ **Do use consistent indentation** - 2 or 4 spaces
✅ **Do use color thoughtfully** - Follow the palette
✅ **Do keep it simple** - Content over chrome

---

## Implementation Checklist

For each screen:
- [ ] Remove all box drawing characters
- [ ] Remove boxLine() and postLine() calls
- [ ] Add decorative header using sectionHeader()
- [ ] Use separator() between sections
- [ ] Left-align all content with 2-space indent
- [ ] Use navigationOptions() for menu
- [ ] Update prompts to use navPrompt()
- [ ] Test with different terminal widths
- [ ] Verify color consistency
- [ ] Check spacing and whitespace

---

## Maintenance Notes

**Adding a new screen:**
1. Start with `clearScreen()`
2. Add header with `sectionHeader(title)`
3. Content with 2-space indent
4. Use `separator()` between sections
5. End with `navigationOptions()` and `navPrompt()`

**Updating styles globally:**
- Modify the shared functions in this document
- Update the helper functions in terminal.js
- Test on all screens
- Document changes in git commit

**Color changes:**
- Update the palette section here first
- Find/replace color codes in terminal.js
- Test contrast and readability
- Verify ANSI art still looks good
