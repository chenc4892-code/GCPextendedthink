/**
 * Claude Extended Thinking - SillyTavern Extension
 *
 * Injects Claude thinking parameters for Custom/OpenAI-compatible endpoints.
 * Also sends narrow plugin flags for the native Anthropic backend path.
 */

import { extension_settings } from '../../../extensions.js';
import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { chat_completion_sources } from '../../../openai.js';

const MODULE_NAME = 'claude-extended-thinking';
const LOG_PREFIX = '[ClaudeExtThinking]';

const DEFAULT_MODEL_REGEX = '(?:claude-(?:3[-.]?7|.*(?:opus|sonnet|haiku|fable).*(?:4|4[-.]?[5-9]|5)|.*(?:4|4[-.]?[5-9]|5).*(?:opus|sonnet|haiku|fable))|(?:^|[/_.-])fable[-_.]?5(?:$|[/_.-]))';

const THINKING_MODE = {
    AUTO: 'auto',
    ADAPTIVE: 'adaptive',
    EXTENDED: 'extended',
};

const defaultSettings = {
    enabled: false,
    thinkingMode: THINKING_MODE.AUTO,
    budgetMode: 'auto',
    budgetTokens: 10000,
    adaptiveEffort: 'high',
    modelRegex: DEFAULT_MODEL_REGEX,
};

function calculateBudgetTokens(maxTokens, reasoningEffort) {
    const MIN_BUDGET = 1024;
    const safeMaxTokens = Math.max(Number(maxTokens) || 4096, MIN_BUDGET + 1);
    let budget;

    switch (reasoningEffort) {
        case 'min':
            budget = MIN_BUDGET;
            break;
        case 'low':
            budget = Math.floor(safeMaxTokens * 0.1);
            break;
        case 'medium':
            budget = Math.floor(safeMaxTokens * 0.25);
            break;
        case 'high':
            budget = Math.floor(safeMaxTokens * 0.5);
            break;
        case 'max':
            budget = Math.floor(safeMaxTokens * 0.95);
            break;
        case 'auto':
        default:
            budget = Math.floor(safeMaxTokens * 0.5);
            break;
    }

    return Math.max(budget, MIN_BUDGET);
}

function getBudgetTokens(generateData, settings) {
    if (settings.budgetMode === 'manual') {
        return Math.max(Number(settings.budgetTokens) || 1024, 1024);
    }

    return calculateBudgetTokens(generateData.max_tokens, generateData.reasoning_effort || 'high');
}

function regexMatchesSample(regexString, sample) {
    try {
        return new RegExp(regexString, 'i').test(sample);
    } catch {
        return false;
    }
}

function migrateModelRegex(settings) {
    const regex = String(settings.modelRegex || '');

    // SillyTavern persists extension_settings. If the user already saved the old regex,
    // changing defaultSettings alone will not update the UI value or injection behavior.
    if (!regex || !regexMatchesSample(regex, 'claude-sonnet-5') || !regexMatchesSample(regex, 'fable-5')) {
        settings.modelRegex = DEFAULT_MODEL_REGEX;
        return true;
    }

    return false;
}

function isClaudeThinkingModel(modelName) {
    const settings = extension_settings[MODULE_NAME];

    try {
        const regex = new RegExp(settings.modelRegex, 'i');
        return regex.test(String(modelName || ''));
    } catch {
        console.warn(LOG_PREFIX, 'Invalid model regex:', settings.modelRegex);
        return false;
    }
}

function isAdaptiveOnlyModel(modelName) {
    const model = String(modelName || '').toLowerCase();

    // Opus 4.6/4.7/4.8+ and Claude 5 family should use adaptive thinking.
    // Sonnet 5 / Fable 5 do not reliably show thinking through the old Extended budget path.
    return /claude-.*(?:opus|sonnet|fable).*?(?:4[-.]?[6-9]|5)/.test(model)
        || /claude-.*(?:4[-.]?[6-9]|5).*?(?:opus|sonnet|fable)/.test(model)
        || /(?:^|[/_.-])fable[-_.]?5(?:$|[/_.-])/.test(model);
}

function resolveThinkingMode(modelName, settings) {
    if (settings.thinkingMode === THINKING_MODE.ADAPTIVE || settings.thinkingMode === THINKING_MODE.EXTENDED) {
        return settings.thinkingMode;
    }

    return isAdaptiveOnlyModel(modelName) ? THINKING_MODE.ADAPTIVE : THINKING_MODE.EXTENDED;
}

function appendYaml(existingYaml, yamlToAppend) {
    const existing = String(existingYaml || '').trimEnd();
    return existing ? `${existing}\n${yamlToAppend}` : yamlToAppend;
}

function removeTopLevelYamlKeys(yamlString, keys) {
    if (!yamlString) {
        return '';
    }

    const keyPattern = keys.map(key => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const topLevelKey = new RegExp(`^(${keyPattern})\\s*:`);
    const lines = String(yamlString).split(/\r?\n/);
    const kept = [];
    let skippingBlock = false;

    for (const line of lines) {
        if (skippingBlock) {
            if (line.trim() === '' || /^\s/.test(line)) {
                continue;
            }

            skippingBlock = false;
        }

        if (topLevelKey.test(line)) {
            skippingBlock = true;
            continue;
        }

        kept.push(line);
    }

    return kept.join('\n').trim();
}

function appendExcludeKeys(existingYaml, keys) {
    const existing = String(existingYaml || '').trimEnd();
    const excludeYaml = keys.map(key => `- ${key}`).join('\n');
    return existing ? `${existing}\n${excludeYaml}` : excludeYaml;
}

function removeExcludeKeys(existingYaml, keys) {
    if (!existingYaml) {
        return '';
    }

    const keyPattern = keys.map(key => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const listItem = new RegExp(`^\\s*-\\s*(${keyPattern})\\s*$`);
    const objectKey = new RegExp(`^\\s*(${keyPattern})\\s*:\\s*`);

    return String(existingYaml)
        .split(/\r?\n/)
        .filter(line => !listItem.test(line) && !objectKey.test(line))
        .join('\n')
        .trim();
}

function applyCustomAdaptiveThinking(generateData, settings) {
    const effort = settings.adaptiveEffort || 'high';
    const adaptiveYaml = [
        'thinking:',
        '  type: adaptive',
        '  display: summarized',
        'output_config:',
        `  effort: ${effort}`,
        'temperature: 1',
    ].join('\n');

    generateData.temperature = 1;
    generateData.custom_include_body = removeTopLevelYamlKeys(generateData.custom_include_body, ['thinking', 'output_config', 'temperature', 'top_p', 'top_k']);
    generateData.custom_include_body = appendYaml(generateData.custom_include_body, adaptiveYaml);
    generateData.custom_exclude_body = removeExcludeKeys(generateData.custom_exclude_body, ['temperature', 'top_p', 'top_k']);
    generateData.custom_exclude_body = appendExcludeKeys(generateData.custom_exclude_body, ['top_p', 'top_k']);
}

function applyCustomExtendedThinking(generateData, budgetTokens) {
    if (generateData.max_tokens && generateData.max_tokens <= budgetTokens) {
        generateData.max_tokens = budgetTokens + 1024;
        console.info(LOG_PREFIX, `Auto-increased max_tokens to ${generateData.max_tokens} (must be > budget_tokens ${budgetTokens})`);
    }

    const extendedYaml = [
        'thinking:',
        '  type: enabled',
        `  budget_tokens: ${budgetTokens}`,
    ].join('\n');

    generateData.custom_include_body = removeTopLevelYamlKeys(generateData.custom_include_body, ['thinking']);
    generateData.custom_include_body = appendYaml(generateData.custom_include_body, extendedYaml);
    generateData.custom_exclude_body = removeExcludeKeys(generateData.custom_exclude_body, ['temperature', 'top_p', 'top_k']);
    generateData.custom_exclude_body = appendExcludeKeys(generateData.custom_exclude_body, ['temperature', 'top_p', 'top_k']);
}

function applyNativeAdaptiveThinking(generateData, settings) {
    const effort = settings.adaptiveEffort || 'high';
    const adaptiveYaml = [
        'thinking:',
        '  type: adaptive',
        '  display: summarized',
        'output_config:',
        `  effort: ${effort}`,
        'temperature: 1',
    ].join('\n');

    // Flags for patched/native Anthropic path.
    generateData.claude_ext_thinking_mode = THINKING_MODE.ADAPTIVE;
    generateData.claude_ext_adaptive_effort = effort;
    generateData.claude_ext_thinking_display = 'summarized';

    // Direct request-body fallback. Some SillyTavern/custom-proxy paths ignore the
    // narrow claude_ext_* flags but still honor custom_include_body.
    generateData.custom_include_body = removeTopLevelYamlKeys(generateData.custom_include_body, ['thinking', 'output_config', 'temperature', 'top_p', 'top_k']);
    generateData.custom_include_body = appendYaml(generateData.custom_include_body, adaptiveYaml);
    generateData.custom_exclude_body = removeExcludeKeys(generateData.custom_exclude_body, ['temperature', 'top_p', 'top_k']);
    generateData.custom_exclude_body = appendExcludeKeys(generateData.custom_exclude_body, ['top_p', 'top_k']);

    // Direct object fallback for request builders that preserve top-level generateData.
    generateData.thinking = { type: THINKING_MODE.ADAPTIVE, display: 'summarized' };
    generateData.output_config = Object.assign({}, generateData.output_config || {}, { effort });

    generateData.temperature = 1;
    delete generateData.top_p;
    delete generateData.top_k;
}

function applyNativeExtendedThinking(generateData, budgetTokens) {
    if (generateData.max_tokens && generateData.max_tokens <= budgetTokens) {
        generateData.max_tokens = budgetTokens + 1024;
        console.info(LOG_PREFIX, `Auto-increased max_tokens to ${generateData.max_tokens} (must be > budget_tokens ${budgetTokens})`);
    }

    generateData.claude_ext_thinking_mode = THINKING_MODE.EXTENDED;
    generateData.claude_ext_budget_tokens = budgetTokens;
    delete generateData.temperature;
    delete generateData.top_p;
    delete generateData.top_k;
}

function onChatCompletionSettingsReady(generateData) {
    const settings = extension_settings[MODULE_NAME];
    if (!settings || !settings.enabled) return;

    if (![chat_completion_sources.CUSTOM, chat_completion_sources.CLAUDE].includes(generateData.chat_completion_source)) {
        return;
    }

    if (!isClaudeThinkingModel(generateData.model)) {
        console.info(LOG_PREFIX, `Skipped: model does not match regex. model=${generateData.model}, regex=${settings.modelRegex}`);
        return;
    }

    const thinkingMode = resolveThinkingMode(generateData.model, settings);

    if (generateData.chat_completion_source === chat_completion_sources.CUSTOM) {
        if (thinkingMode === THINKING_MODE.ADAPTIVE) {
            applyCustomAdaptiveThinking(generateData, settings);
        } else {
            applyCustomExtendedThinking(generateData, getBudgetTokens(generateData, settings));
        }
    } else if (thinkingMode === THINKING_MODE.ADAPTIVE) {
        applyNativeAdaptiveThinking(generateData, settings);
    } else {
        applyNativeExtendedThinking(generateData, getBudgetTokens(generateData, settings));
    }

    console.info(LOG_PREFIX, `Injected ${thinkingMode} thinking for model=${generateData.model}`);
}

function loadSettings() {
    extension_settings[MODULE_NAME] = Object.assign(
        {},
        defaultSettings,
        extension_settings[MODULE_NAME] || {},
    );

    const settings = extension_settings[MODULE_NAME];

    if (migrateModelRegex(settings)) {
        saveSettingsDebounced();
        console.info(LOG_PREFIX, 'Migrated model regex for Sonnet 5 / Fable 5 support.');
    }

    $('#claude_ext_thinking_enabled').prop('checked', settings.enabled);
    $('#claude_ext_thinking_mode').val(settings.thinkingMode);
    $('#claude_ext_thinking_budget_mode').val(settings.budgetMode);
    $('#claude_ext_thinking_budget_tokens').val(settings.budgetTokens);
    $('#claude_ext_thinking_adaptive_effort').val(settings.adaptiveEffort);
    $('#claude_ext_thinking_model_regex').val(settings.modelRegex);

    updateModeVisibility(settings.thinkingMode);
}

function updateModeVisibility(mode) {
    const showExtended = mode !== THINKING_MODE.ADAPTIVE;
    const showAdaptive = mode !== THINKING_MODE.EXTENDED;

    $('#claude_ext_thinking_extended_group').toggle(showExtended);
    $('#claude_ext_thinking_adaptive_group').toggle(showAdaptive);
    $('#claude_ext_thinking_manual_group').toggle(showExtended && extension_settings[MODULE_NAME].budgetMode === 'manual');
}

function bindEvents() {
    $('#claude_ext_thinking_enabled').on('change', function () {
        extension_settings[MODULE_NAME].enabled = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#claude_ext_thinking_mode').on('change', function () {
        const mode = String($(this).val());
        extension_settings[MODULE_NAME].thinkingMode = mode;
        updateModeVisibility(mode);
        saveSettingsDebounced();
    });

    $('#claude_ext_thinking_budget_mode').on('change', function () {
        extension_settings[MODULE_NAME].budgetMode = String($(this).val());
        updateModeVisibility(extension_settings[MODULE_NAME].thinkingMode);
        saveSettingsDebounced();
    });

    $('#claude_ext_thinking_budget_tokens').on('input', function () {
        extension_settings[MODULE_NAME].budgetTokens = Number($(this).val()) || 10000;
        saveSettingsDebounced();
    });

    $('#claude_ext_thinking_adaptive_effort').on('change', function () {
        extension_settings[MODULE_NAME].adaptiveEffort = String($(this).val());
        saveSettingsDebounced();
    });

    $('#claude_ext_thinking_model_regex').on('input', function () {
        extension_settings[MODULE_NAME].modelRegex = String($(this).val());
        saveSettingsDebounced();
    });
}

const settingsHtml = `
<div id="claude-ext-thinking-settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Claude Extended Thinking</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div class="flex-container flexFlowColumn">
                <small>为 Claude 注入思考参数，支持 Custom/OpenAI 兼容端点和原生 Anthropic Claude。</small>
                <small>本插件由金瓜瓜API@gua.guagua.uk开发。</small>
                <br>
                <label class="checkbox_label" for="claude_ext_thinking_enabled">
                    <input type="checkbox" id="claude_ext_thinking_enabled" />
                    <span>启用 Claude 思考</span>
                </label>
                <br>
                <label for="claude_ext_thinking_mode">思考模式</label>
                <select id="claude_ext_thinking_mode" class="text_pole">
                    <option value="auto">自动：Sonnet 5 / Fable 5 / Opus 4.6+ 使用自适应，旧模型使用 Extended</option>
                    <option value="adaptive">自适应：thinking.type adaptive</option>
                    <option value="extended">Extended：thinking.type enabled + budget_tokens</option>
                </select>
                <small>Sonnet 5 / Fable 5 / Opus 4.7+ 请使用自适应；自动模式会优先走 adaptive。</small>
                <br>
                <div id="claude_ext_thinking_adaptive_group">
                    <label for="claude_ext_thinking_adaptive_effort">自适应思考强度</label>
                    <select id="claude_ext_thinking_adaptive_effort" class="text_pole">
                        <option value="high">高</option>
                        <option value="xhigh">超高</option>
                        <option value="max">最大</option>
                        <option value="medium">中</option>
                        <option value="low">低</option>
                    </select>
                    <small>自适应模式会显式注入 thinking.display summarized、output_config.effort，并将温度设为 1。Sonnet 5/Fable 5 默认会 omitted，不显式写 display 就可能看不到思考摘要。</small>
                </div>
                <div id="claude_ext_thinking_extended_group">
                    <label for="claude_ext_thinking_budget_mode">Extended 预算模式</label>
                    <select id="claude_ext_thinking_budget_mode" class="text_pole">
                        <option value="auto">自动：跟随 Reasoning Effort</option>
                        <option value="manual">手动指定 budget_tokens</option>
                    </select>
                    <div id="claude_ext_thinking_manual_group">
                        <label for="claude_ext_thinking_budget_tokens">Budget Tokens</label>
                        <input type="number" id="claude_ext_thinking_budget_tokens" class="text_pole" min="1024" max="1000000" step="1024" value="10000" />
                        <small>最小值为 1024，仅 Extended 模式使用。</small>
                    </div>
                </div>
                <br>
                <label for="claude_ext_thinking_model_regex">模型匹配规则（正则）</label>
                <input type="text" id="claude_ext_thinking_model_regex" class="text_pole"
                       value="${defaultSettings.modelRegex.replace(/"/g, '&quot;')}" />
                <small>只有匹配到的模型名才会注入思考参数。</small>
            </div>
        </div>
    </div>
</div>`;

jQuery(async () => {
    $('#extensions_settings2').append(settingsHtml);

    loadSettings();
    bindEvents();

    eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, onChatCompletionSettingsReady);

    console.info(LOG_PREFIX, 'Extension loaded.');
});
