# Draw determinism hashes

This suite runs eight seeded draw scenarios through the `draw.generate` operation, projects each
round onto its semantic draw data, and checks its SHA-256 hash. Each scenario is run twice in one
process to catch accidental nondeterminism, then compared with the committed value in
`draw-hashes.json`.

Update the hashes only after a deliberate, reviewed change to draw logic that is intended to alter
draw output. Review the scenario output and resulting hash diff, then commit the updated hashes with
the draw logic change. Run `npm run determinism:update` to regenerate the file.
