local logger = require("logger")
local millennium = require("millennium")

local VALID_MODES = {
    text = true,
    highlight = true,
    hide = true,
}

local VALID_FLAG_KEYS = {
    ignoreLocalization = true,
    ignoreCode = true,
    ignoreConceptArt = true,
    ignoreMarketing = true,
    ignoreEarlyAccess = true,
    ignorePreRelease = true,
}

local function build_settings_snapshot()
    local mode = millennium.config.get("filterMode")
    if type(mode) ~= "string" or not VALID_MODES[mode] then
        mode = "text"
    end

    return {
        filterMode = mode,
        ignoreLocalization = millennium.config.get("ignoreLocalization") == true,
        ignoreCode = millennium.config.get("ignoreCode") == true,
        ignoreConceptArt = millennium.config.get("ignoreConceptArt") == true,
        ignoreMarketing = millennium.config.get("ignoreMarketing") == true,
        ignoreEarlyAccess = millennium.config.get("ignoreEarlyAccess") == true,
        ignorePreRelease = millennium.config.get("ignorePreRelease") == true,
        cacheRevision = tonumber(millennium.config.get("cacheRevision")) or 1,
    }
end

---@ffi
---Return the current plugin filter configuration and cache revision
---@return table
function getSettings()
    return build_settings_snapshot()
end

---@ffi
---Update active display mode ("text", "highlight", or "hide")
---@param mode string
---@return table
function setFilterMode(mode)
    if VALID_MODES[mode] then
        millennium.config.set("filterMode", mode)
    else
        logger:warn("Ignored invalid filterMode: " .. tostring(mode))
    end
    return build_settings_snapshot()
end

---@ffi
---Update a category exception boolean flag
---@param key string
---@param enabled boolean
---@return table
function setFilterFlag(key, enabled)
    if VALID_FLAG_KEYS[key] then
        millennium.config.set(key, enabled == true)
    else
        logger:warn("Ignored unknown filter flag key: " .. tostring(key))
    end
    return build_settings_snapshot()
end

---@ffi
---Return total checked and flagged game counters
---@return table
function getStats()
    return {
        totalChecked = tonumber(millennium.config.get("totalChecked")) or 0,
        totalFlagged = tonumber(millennium.config.get("totalFlagged")) or 0,
    }
end

---@ffi
---Increment scan counters by the given delta
---@param checked integer
---@param flagged integer
---@return table
function incrementStats(checked, flagged)
    local totalChecked = (tonumber(millennium.config.get("totalChecked")) or 0) + (tonumber(checked) or 0)
    local totalFlagged = (tonumber(millennium.config.get("totalFlagged")) or 0) + (tonumber(flagged) or 0)
    millennium.config.set("totalChecked", totalChecked)
    millennium.config.set("totalFlagged", totalFlagged)
    return {
        totalChecked = totalChecked,
        totalFlagged = totalFlagged,
    }
end

---@ffi
---Reset scan counters to zero
---@return table
function resetStats()
    millennium.config.set("totalChecked", 0)
    millennium.config.set("totalFlagged", 0)
    return {
        totalChecked = 0,
        totalFlagged = 0,
    }
end

---@ffi
---Increment cache revision so Store webkit pages purge cached disclosures
---@return integer
function bumpCacheRevision()
    local nextRev = (tonumber(millennium.config.get("cacheRevision")) or 1) + 1
    millennium.config.set("cacheRevision", nextRev)
    return nextRev
end

---@ffi
---Read the bundled warning SVG icon asset
---@return string
function getWarningIconSvg()
    return millennium.assets.read("resources/iconsvg.svg") or ""
end

logger:info("Registered Steam AI Disclosure Filter RPC functions")
