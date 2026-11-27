local logger = require("logger")
local millennium = require("millennium")

-- Register FFI RPC endpoints for frontend and webkit contexts
require("rpc_functions")

local DEFAULT_CONFIG = {
    filterMode = "text",
    ignoreLocalization = false,
    ignoreCode = false,
    ignoreConceptArt = false,
    ignoreMarketing = false,
    ignoreEarlyAccess = false,
    ignorePreRelease = false,
    cacheRevision = 1,
    totalChecked = 0,
    totalFlagged = 0,
}

local function ensure_defaults()
    for key, default_val in pairs(DEFAULT_CONFIG) do
        if millennium.config.get(key) == nil then
            millennium.config.set(key, default_val)
        end
    end
end

local function on_load()
    ensure_defaults()
    logger:info("Loaded Steam AI Disclosure Filter on Millennium v" .. millennium.version())
    millennium.ready()
end

local function on_unload()
    logger:info("Steam AI Disclosure Filter unloaded")
end

return {
    on_load = on_load,
    on_unload = on_unload,
}
