# Sheet Sort & Filter

Install in Foundry: Add-on Modules → Install Module → paste this Manifest URL:

    https://github.com/PsyK2812/foundry-sheet-sort-filter/releases/latest/download/module.json

Excel-style sorting and filtering for the dnd5e character sheet. Works on every item list that uses the dnd5e inventory, including Inventory, Features, Spells and container sheets.

Requires Foundry VTT v14 and dnd5e 6.x (tested against 6.0.6).

## Use
- **Click a column header** (Price, Weight, Quantity, Charges, Uses, Range…) to sort: ascending → descending → back to normal order.
- **Click the small ▾ on a header** to open its menu:
  - sort ascending / descending
  - tick values on and off, like Excel's AutoFilter (with *(Select all)*, a search box for long lists and *(Blanks)*)
  - for number columns, a **min – max** range (Price is compared in gp, so 5 pp counts as 50 gp)
- **The ▾ next to the section title** (Weapons, Equipment…) has *Name contains*, plus **Type** and **Rarity** filters.
- Filters from different columns combine. Each section is sorted separately, and a section with nothing left in it is hidden.
- dnd5e's own search box and filters still work alongside this module. Its **✕ (clear)** button also clears this module's filters.

A sorted column shows an arrow, and a filtered column shows a gold funnel.

## Notes
- Sorting and filtering only change the view. Items keep their manual order, and switching sorting off brings that order back.
- Settings are saved per user, per actor and per list, in this browser. Turn this off under *Configure Settings → Sheet Sort & Filter → Remember sorting & filters*.
- Players can't use this to learn about unidentified items: their price and rarity count as blank.
- Macro to forget all saved sorts/filters: `game.modules.get("sheet-sort-filter").api.resetAll()`
