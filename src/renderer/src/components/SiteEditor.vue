<script setup lang="ts">
import { computed, ref } from 'vue'
import type { SiteKind, SiteProfile } from '../../../shared/contracts'

const props = defineProps<{ initial: SiteProfile | null }>()
const emit = defineEmits<{ close: []; saved: [SiteProfile] }>()

const label = ref(props.initial?.label ?? '')
const baseUrl = ref(props.initial?.baseUrl ?? '')

const detected = ref<SiteKind | null>(props.initial?.kind ?? null)
const busy = ref(false)
const error = ref('')

const isEdit = computed(() => Boolean(props.initial))
/** 地址一改，手上的令牌就不再属于这个站，只能重新登录一次 */
const urlChanged = computed(() => baseUrl.value.trim() !== (props.initial?.baseUrl ?? ''))
const canSave = computed(() => isEdit.value && !urlChanged.value && !busy.value)
const canLogin = computed(() => baseUrl.value.trim().length > 0 && !busy.value)

const tokenHint = computed(() => {
  if (urlChanged.value) return '地址已改动，原令牌不再适用，需要重新登录'
  if (!props.initial) return ''
  return props.initial.hasToken
    ? `已保存令牌（${props.initial.account}），重新登录会替换它`
    : '还没有可用令牌'
})

async function detect(): Promise<void> {
  const target = baseUrl.value.trim()
  if (!target) return
  const res = await window.apiShow.detect(target)
  detected.value = res.ok ? res.data : null
  if (!res.ok) error.value = res.error.message
}

async function save(): Promise<void> {
  busy.value = true
  error.value = ''

  const res = await window.apiShow.sitesSave({
    id: props.initial?.id,
    label: label.value,
    baseUrl: baseUrl.value.trim(),
    kind: detected.value ?? 'sub2api',
    account: props.initial?.account ?? ''
  })

  busy.value = false
  if (!res.ok) {
    error.value = res.error.message
    return
  }
  emit('saved', res.data)
}

async function login(): Promise<void> {
  busy.value = true
  error.value = ''

  const res = await window.apiShow.capture({
    id: props.initial?.id,
    baseUrl: baseUrl.value.trim(),
    label: label.value
  })

  busy.value = false
  if (!res.ok) {
    error.value = res.error.message
    return
  }
  emit('saved', res.data)
}
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="dialog">
      <header>
        <h3>{{ isEdit ? '编辑站点' : '添加站点' }}</h3>
        <button class="x" @click="emit('close')">×</button>
      </header>

      <div class="body">
        <div class="field">
          <label>站点地址</label>
          <div class="line">
            <input
              v-model="baseUrl"
              placeholder="https://your-relay-site.com"
              spellcheck="false"
              @blur="detect"
              @keyup.enter="login"
            />
            <span v-if="detected" class="tag" :class="detected">
              {{ detected === 'sub2api' ? 'sub2api' : 'new-api' }}
            </span>
            <span v-else class="dim">未识别</span>
          </div>
        </div>

        <div class="field">
          <label>显示名称（留空用域名）</label>
          <input v-model="label" placeholder="噜噜 AI" />
        </div>

        <p v-if="detected === 'newapi'" class="err">
          new-api 站点已不再支持，只能添加 sub2api 站点。
        </p>
        <p v-else class="note">
          「打开浏览器登录」会开一个真实浏览器窗口，你在里面照常登录并通过人机验证。
          工具要等到拿到能用通用量接口的那枚令牌才关窗口，之后每次查询都沿用；
          面板令牌通常一天过期，取不到数据时再来登一次即可。
        </p>

        <p v-if="isEdit" class="hint">{{ tokenHint }}</p>

        <p v-if="error" class="err">{{ error }}</p>
      </div>

      <footer>
        <button class="btn ghost" :disabled="busy" @click="emit('close')">取消</button>
        <button v-if="canSave" class="btn ghost" @click="save">保存</button>
        <button class="btn" :disabled="!canLogin" @click="login">
          {{ busy ? '等待登录…' : '打开浏览器登录' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  z-index: 20;
  display: grid;
  place-items: center;
  background: var(--mask);
}

.dialog {
  width: 520px;
  background: var(--panel);
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  box-shadow: var(--shadow-dialog);
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}

h3 {
  margin: 0;
  font-size: 14px;
}

.x {
  border: 0;
  background: transparent;
  font-size: 20px;
  line-height: 1;
  color: var(--text-faint);
}

.body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
}

.line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.line input {
  flex: 1;
  min-width: 0;
}

.note {
  margin: 0;
  padding: 8px 10px;
  border-radius: 4px;
  background: var(--panel-alt);
  border: 1px solid var(--border);
  color: var(--text-dim);
  font-size: 12px;
}

.hint {
  margin: 0;
  font-size: 11px;
  color: var(--text-faint);
}

.dim {
  font-size: 11px;
  color: var(--text-faint);
  white-space: nowrap;
}

.err {
  margin: 0;
  padding: 6px 10px;
  border-radius: 4px;
  background: var(--tint-bad);
  color: var(--bad);
  font-size: 12px;
}

footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
}
</style>
