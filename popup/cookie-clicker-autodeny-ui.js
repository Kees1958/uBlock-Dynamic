/*******************************************************************************

    uBlock-Stripped-Dynamic — Cookie Consent Clicker popup menu item (v8.5.1)

    REMOVED (8.5.1): the live countdown, active-state label swap
    ("Never consent active — tap to stop"), and transaction-warning
    tooltip this file used to render on #gotoCookieClicker — per
    explicit request. The underlying "Never consent" auto-deny session
    is now started exclusively from the Worry-free menu item's own
    picker (#worryFreeModal, see popup/worry-free-ui.js), not from this
    one — #gotoCookieClicker's own click handler (popup.js) has for a
    while now only ever launched the one-off Cancel/Automate picker
    unconditionally, regardless of session state, so showing THIS menu
    item as if it tracked/controlled that session was stale, duplicate
    information (the real state is already shown on the Worry-free item
    itself). #cookieClickerAutoDenyLabel now stays exactly as its plain
    HTML default ("Cookie consent clicker") always — a genuinely static
    menu entry, nothing left for this file to do at popup-open time.

    Kept as an (empty) module rather than deleting the file and its
    <script> tag from popup.html, so a future re-add doesn't need to
    re-wire the load order — see CHANGELOG for the full history this
    replaces (originally v8.2).

*******************************************************************************/
