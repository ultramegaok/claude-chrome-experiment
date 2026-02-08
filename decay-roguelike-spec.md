# Decay Roguelike: Design Specification

## Core Concept
A roguelike where the dungeon floor is constantly decaying. Each tile has a visible lifespan (turns until collapse). The player must navigate through dying terrain, collecting time crystals while managing the collapsing environment through puzzle-like manipulation.

## Core Mechanic: Temporal Decay

### Tile Decay System
- Every floor tile has a **decay timer** (integer, turns until collapse)
- Timers are **visible** on tiles (color-coded + optional numbers)
- When timer hits 0, tile becomes impassable void
- Different tiles start with different timers (varied terrain stability)

### Visual Decay Phases
1. **Solid (6+ turns)**: Full brightness floor color
2. **Stable (4-5 turns)**: Slightly dimmed, hairline cracks
3. **Cracked (2-3 turns)**: Yellow/orange tint, visible cracks
4. **Crumbling (1 turn)**: Red/danger color, heavy damage texture
5. **Collapsed (0)**: Void/pit, impassable

### Decay Progression
- Each turn, all tiles lose 1 from their timer
- **Crumble Chains**: When a tile collapses, adjacent tiles lose 1-2 extra turns
- Cascade collapses create dynamic, evolving terrain

## Puzzle Element: Pushable Pillars

### Pillar Mechanics
- Pillars are pushable objects (sokoban-style)
- While a pillar occupies a tile, that tile **does not decay**
- Adjacent tiles to pillars decay at **half rate** (round up)
- Pillars can be pushed onto any floor tile (not void)
- Pillars block movement

### Strategic Depth
- Position pillars to create stable paths
- Sacrifice unstable areas to protect critical routes
- Limited pillars per level forces prioritization

## Goal System: Time Crystals

### Crystal Mechanics
- Each level has N time crystals to collect
- Crystals spawn on tiles with **low stability** (2-4 turns remaining)
- Collecting a crystal is optional but provides:
  - Score/progression
  - Bonus resources (stabilizer potions)
  - Required for "true" completion
- Walking onto crystal tile collects it automatically

### Risk/Reward Loop
- High-value crystals appear on dangerous tiles
- Player must calculate: "Can I reach that crystal and escape before the path collapses?"

## Prediction System

### Future Vision (Tab Key)
- Toggle to see map state N turns in the future
- Shows which tiles will have collapsed
- Essential for route planning
- Could be limited resource or cooldown

### Visual Indicators
- Tiles about to chain-collapse show warning indicators
- Cascade paths visualized when hovering

## Level Structure

### Level Generation
- Standard room+corridor generation
- Tiles assigned initial decay timers:
  - Room interiors: Higher stability (8-15 turns)
  - Corridors: Medium stability (5-10 turns)
  - Edges/corners: Lower stability (3-7 turns)
- Stairs spawn in stable location
- Crystals spawn on unstable tiles
- 2-4 pillars placed per level

### Win Condition
- Reach the stairs before all paths collapse
- Bonus: Collect all time crystals

### Fail Condition
- Player stands on tile when it collapses
- All paths to stairs become void

## Player Abilities

### Basic Movement
- 8-directional movement (existing)
- Each move = 1 turn = all tiles decay by 1

### Actions
- **Push Pillar**: Move into pillar direction to push (costs 1 turn)
- **Wait**: Skip turn (tiles still decay - usually bad!)
- **Use Stabilizer**: Consumable, resets adjacent tiles to +5 turns

## Items

### Stabilizer Potion
- Resets all tiles in 3x3 area to +5 turns
- Limited quantity per level
- Can save a collapsing path

### Anchor Stone
- Place on tile to make it permanently stable
- Very rare, strategic placement crucial

### Decay Bomb
- Throw to instantly collapse tiles in area
- Tactical: collapse tiles to trigger chain reactions strategically
- Could collapse tiles under enemies

## Enemies (Future)

### Decay Walkers
- Move toward player
- Tiles they stand on decay 2x faster
- Killing them drops stabilizer essence

### Void Spawns
- Emerge from collapsed tiles
- Encourage forward momentum

## UI Requirements

### Tile Display
- Base floor color modified by decay phase
- Small number showing turns remaining (toggle-able)
- Crack/damage overlay sprites

### Prediction Mode
- Grayscale/blue tint overlay
- Collapsed tiles shown as void
- Clear visual distinction from normal view

### HUD Elements
- Turn counter
- Crystals collected / total
- Stabilizer potion count
- Current tile stability

## Technical Implementation Notes

### Data Structures
```javascript
// Extend tile types
const TILE = {
    VOID: -1,      // Collapsed, impassable
    WALL: 0,
    FLOOR: 1,
    STAIRS: 2,
    CRYSTAL: 3,
    PILLAR: 4
};

// Add decay map parallel to tile map
gameState.decay = [];  // 2D array of integers (turns remaining)
gameState.pillars = []; // Array of {x, y} positions
gameState.crystals = []; // Array of {x, y, collected}

// Decay phase thresholds
const DECAY_PHASE = {
    SOLID: 6,      // 6+ turns: full stability
    STABLE: 4,     // 4-5 turns: minor cracks
    CRACKED: 2,    // 2-3 turns: danger
    CRUMBLING: 1,  // 1 turn: critical
    COLLAPSED: 0   // void
};
```

### Per-Turn Update
```javascript
function processTurnDecay() {
    const collapsed = [];
    
    // Decay all non-pillar tiles
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (isPillarAt(x, y)) continue;
            if (isAdjacentToPillar(x, y)) {
                // Half decay rate
                if (gameState.turn % 2 === 0) {
                    gameState.decay[y][x]--;
                }
            } else {
                gameState.decay[y][x]--;
            }
            
            if (gameState.decay[y][x] <= 0) {
                collapsed.push({x, y});
            }
        }
    }
    
    // Process collapses
    for (const tile of collapsed) {
        collapseTile(tile.x, tile.y);
    }
    
    // Chain reaction
    processChainCollapses(collapsed);
}
```

### Prediction Calculation
```javascript
function predictMapState(turnsAhead) {
    // Clone current decay state
    const futureDecay = cloneDecay(gameState.decay);
    
    // Simulate N turns of decay
    for (let t = 0; t < turnsAhead; t++) {
        simulateDecayTurn(futureDecay);
    }
    
    return futureDecay;
}
```

## Questions for Design Refinement

1. Should pillars be pushable onto void (falling in, lost)?
2. How many crystals per level? All required or optional?
3. Should player have a "stabilize current tile" action?
4. Chain collapse intensity: -1 or -2 turns to adjacent?
5. Should corridors be more dangerous than rooms?
6. Fog of war: Can you see decay timers on unexplored tiles?
7. Should there be safe "anchor" tiles that never decay?
8. Multiple stairs or single exit?
