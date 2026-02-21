/**
 * Claude Extended Thinking - SillyTavern Extension
 *
 * 在 OpenAI 兼容模式（Custom源）下为 Claude 模型注入 Extended Thinking 参数。
 * 通过 CHAT_COMPLETION_SETTINGS_READY 事件拦截请求，动态修改
 * custom_include_body / custom_exclude_body YAML，将 thinking 对象注入请求体。
 */

import { extension_settings } from '../../../extensions.js';
import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { chat_completion_sources } from '../../../openai.js';

const MODULE_NAME = 'claude-extended-thinking';
const LOG_PREFIX = '[ClaudeExtThinking]';

// Default settings
const defaultSettings = {
    enabled: false,
    budgetMode: 'auto',        // 'auto' | 'manual'
    budgetTokens: 10000,       // manual budget tokens
    modelRegex: 'claude-(3-7|3\\.7|opus-4|sonnet-4|haiku-4|opus-4)',
};

/**
 * Calculate budget_tokens from reasoning_effort and max_tokens.
 * Mirrors the logic in src/prompt-converters.js:calculateClaudeBudgetTokens
 */
function calculateBudgetTokens(maxTokens, reasoningEffort) {
    const MIN_BUDGET = 1024;
    let budget;

    switch (reasoningEffort) {
        case 'min':
            budget = MIN_BUDGET;
            break;
        case 'low':
            budget = Math.floor(maxTokens * 0.1);
            break;
        case 'medium':
            budget = Math.floor(maxTokens * 0.25);
            break;
        case 'high':
            budget = Math.floor(maxTokens * 0.5);
            break;
        case 'max':
            budget = Math.floor(maxTokens * 0.95);
            break;
        case 'auto':
        default:
            // 'auto' → let the API decide; use a reasonable default
            budget = Math.floor(maxTokens * 0.5);
            break;
    }

    return Math.max(budget, MIN_BUDGET);
}

/**
 * Check if a model name matches the Claude extended-thinking pattern.
 */
function isClaudeThinkingModel(modelName) {
    const settings = extension_settings[MODULE_NAME];
    try {
        const regex = new RegExp(settings.modelRegex, 'i');
        return regex.test(modelName);
    } catch {
        console.warn(LOG_PREFIX, 'Invalid model regex:', settings.modelRegex);
        return false;
    }
}

/**
 * CHAT_COMPLETION_SETTINGS_READY handler.
 * Modifies generate_data to inject thinking parameters for Custom source.
 */
function onChatCompletionSettingsReady(generateData) {
    const settings = extension_settings[MODULE_NAME];
    if (!settings || !settings.enabled) return;

    // Only process Custom (OpenAI Compatible) source
    if (generateData.chat_completion_source !== chat_completion_sources.CUSTOM) {
        return;
    }

    // Check model name
    if (!isClaudeThinkingModel(generateData.model)) {
        return;
    }

    // Calculate budget tokens
    let budgetTokens;
    if (settings.budgetMode === 'manual') {
        budgetTokens = Math.max(Number(settings.budgetTokens) || 1024, 1024);
    } else {
        const maxTokens = generateData.max_tokens || 4096;
        const reasoningEffort = generateData.reasoning_effort || 'high';
        budgetTokens = calculateBudgetTokens(maxTokens, reasoningEffort);
    }

    // Ensure max_tokens > budget_tokens (required by Claude API)
    if (generateData.max_tokens && generateData.max_tokens <= budgetTokens) {
        generateData.max_tokens = budgetTokens + 1024;
        console.info(LOG_PREFIX, `Auto-increased max_tokens to ${generateData.max_tokens} (must be > budget_tokens ${budgetTokens})`);
    }

    // Build the thinking YAML to inject
    const thinkingYaml = `\nthinking:\n  type: enabled\n  budget_tokens: ${budgetTokens}`;

    // Append to custom_include_body
    const existingInclude = generateData.custom_include_body || '';
    generateData.custom_include_body = existingInclude + thinkingYaml;

    // Build exclude list for temperature/top_p/top_k (Claude API requires removal when thinking is enabled)
    const excludeKeys = ['temperature', 'top_p', 'top_k'];
    const existingExclude = generateData.custom_exclude_body || '';
    const excludeYaml = excludeKeys.map(k => `\n- ${k}`).join('');
    generateData.custom_exclude_body = existingExclude + excludeYaml;

    console.info(LOG_PREFIX, `Injected extended thinking: budget_tokens=${budgetTokens}, model=${generateData.model}`);
}

/**
 * Load settings from extension_settings and apply to UI.
 */
function loadSettings() {
    extension_settings[MODULE_NAME] = Object.assign(
        {},
        defaultSettings,
        extension_settings[MODULE_NAME] || {},
    );

    const settings = extension_settings[MODULE_NAME];

    $('#claude_ext_thinking_enabled').prop('checked', settings.enabled);
    $('#claude_ext_thinking_budget_mode').val(settings.budgetMode);
    $('#claude_ext_thinking_budget_tokens').val(settings.budgetTokens);
    $('#claude_ext_thinking_model_regex').val(settings.modelRegex);

    toggleManualGroup(settings.budgetMode);
}

/**
 * Show/hide manual budget input based on mode.
 */
function toggleManualGroup(mode) {
    if (mode === 'manual') {
        $('#claude_ext_thinking_manual_group').show();
    } else {
        $('#claude_ext_thinking_manual_group').hide();
    }
}

/**
 * Bind settings UI events.
 */
function bindEvents() {
    $('#claude_ext_thinking_enabled').on('change', function () {
        extension_settings[MODULE_NAME].enabled = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#claude_ext_thinking_budget_mode').on('change', function () {
        const mode = String($(this).val());
        extension_settings[MODULE_NAME].budgetMode = mode;
        toggleManualGroup(mode);
        saveSettingsDebounced();
    });

    $('#claude_ext_thinking_budget_tokens').on('input', function () {
        extension_settings[MODULE_NAME].budgetTokens = Number($(this).val()) || 10000;
        saveSettingsDebounced();
    });

    $('#claude_ext_thinking_model_regex').on('input', function () {
        extension_settings[MODULE_NAME].modelRegex = String($(this).val());
        saveSettingsDebounced();
    });
}

// ================================================================
//  Settings panel HTML (inlined to avoid path issues with git installs)
// ================================================================
const settingsHtml = `
<div id="claude-ext-thinking-settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Claude Extended Thinking</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div class="flex-container flexFlowColumn">
                <small>OpenAI兼容模式下为Claude模型启用Extended Thinking。需要中转API支持thinking参数。</small>
                <br>
                <label class="checkbox_label" for="claude_ext_thinking_enabled">
                    <input type="checkbox" id="claude_ext_thinking_enabled" />
                    <span>启用 Extended Thinking</span>
                </label>
                <br>
                <label for="claude_ext_thinking_budget_mode">Budget 模式</label>
                <select id="claude_ext_thinking_budget_mode" class="text_pole">
                    <option value="auto">自动（跟随 Reasoning Effort）</option>
                    <option value="manual">手动指定</option>
                </select>
                <div id="claude_ext_thinking_manual_group">
                    <label for="claude_ext_thinking_budget_tokens">Budget Tokens</label>
                    <input type="number" id="claude_ext_thinking_budget_tokens" class="text_pole"
                           min="1024" max="1000000" step="1024" value="10000" />
                    <small>最小值 1024。越大允许的思考越充分。</small>
                </div>
                <br>
                <label for="claude_ext_thinking_model_regex">模型匹配规则（正则）</label>
                <input type="text" id="claude_ext_thinking_model_regex" class="text_pole"
                       value="claude-(3-7|3\\.7|opus-4|sonnet-4|haiku-4|opus-4)" />
                <small>匹配到的模型名才会注入 thinking 参数。</small>
            </div>
        </div>
    </div>
</div>`;

// ================================================================
//  Initialization
// ================================================================
jQuery(async () => {
    $('#extensions_settings2').append(settingsHtml);

    loadSettings();
    bindEvents();

    // Register the request interceptor
    eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, onChatCompletionSettingsReady);

    console.info(LOG_PREFIX, 'Extension loaded.');
});
