<script setup lang="ts">
import { computed, ref } from 'vue'
import type { SiteKind, SiteProfile } from '../../../shared/contracts'

const props = defineProps<{ initial: SiteProfile | null }>()
const emit = defineEmits<{ close: []; saved: [SiteProfile] }>()

const label = ref(props.initial?.label ?? '')
const baseUrl = ref(props.initial?.baseUrl ?? '')
const username = ref(props.initial?.username ?? '')
const password = ref('')
const jwt = ref('')
const mode = ref<'password' | 'browser' | 'jwt'>(
  props.initial ? (props.initial.loginMode === 'jwt' ? 'jwt' : 'password') : 'browser'
)

const detected = ref<SiteKind | null>(props.initial?.kind ?? null)
const busy = ref(false)
const error = ref('')

const isEdit = computed(() => Boolean(props.initial))
const canSubmit = computed(() => baseUrl.value.trim().length > 0 && !busy.value)

async function detect(): Promise<void> {
  const target = baseUrl.value.trim()
  if (!target) return
  const res = await window.apiShow.detect(target)
  detected.value = res.ok ? res.data : null
  if (!res.ok) error.value = res.error.message
}

async function submit(): Promise<void> {
  busy.value = true
  error.value = ''
  const target = baseUrl.value.trim()

  if (mode.value === 'browser') {
    const res = await window.apiShow.capture({
      id: props.initial?.id,
      baseUrl: target,
      label: label.value
    })
    busy.value = false
    if (!res.ok) {
      error.value = res.error.message
      return
    }
    emit('saved', res.data)
    return
  }

  const res = await window.apiShow.sitesSave({
    id: props.initial?.id,
    label: label.value,
    baseUrl: target,
    kind: detected.value ?? 'sub2api',
    account: mode.value === 'jwt' ? '' : username.value,
    username: username.value,
    loginMode: mode.value,
    // 编辑时留空表示沿用已保存的凭据，不要覆盖成空
    password: mode.value === 'password' && password.value ? password.value : undefined,
    jwt: mode.value === 'jwt' && jwt.value ? jwt.value : undefined
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
              placeholder="https://luluai.win"
              spellcheck="false"
              @blur="detect"
              @keyup.enter="submit"
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

        <div class="field">
          <label>登录方式</label>
          <div class="modes">
            <button class="seg" :class="{ on: mode === 'browser' }" @click="mode = 'browser'">
              内置浏览器（推荐）
            </button>
            <button class="seg" :class="{ on: mode === 'password' }" @click="mode = 'password'">
              邮箱 + 密码
            </button>
            <button class="seg" :class="{ on: mode === 'jwt' }" @click="mode = 'jwt'">粘贴 JWT</button>
          </div>
        </div>

        <p v-if="mode === 'browser'" class="note">
          保存时会打开一个真实浏览器窗口，你在里面照常登录并通过人机验证，
          工具自动截获面板令牌。之后每次查询都用这个令牌，无需再存密码。
        </p>

        <template v-if="mode === 'password'">
          <div class="two">
            <div class="field">
              <label>邮箱 / 用户名</label>
              <input v-model="username" spellcheck="false" />
            </div>
            <div class="field">
              <label>密码</label>
              <input
                v-model="password"
                type="password"
                :placeholder="initial?.hasPassword ? '已保存，留空则不修改' : '输入密码'"
              />
            </div>
          </div>
          <p class="hint">密码用 Windows 凭据加密后存在本机，不会上传，也不会回传到界面。</p>
        </template>

        <div v-else-if="mode === 'jwt'" class="field">
          <label>面板 JWT（浏览器 F12 → 网络 → 任意请求的 Authorization 头）</label>
          <input
            v-model="jwt"
            placeholder="eyJhbGciOi..."
            spellcheck="false"
            :title="initial?.hasJwt ? '已保存一个令牌，粘贴新的会覆盖' : ''"
          />
        </div>

        <p v-if="error" class="err">{{ error }}</p>
      </div>

      <footer>
        <button class="btn ghost" :disabled="busy" @click="emit('close')">取消</button>
        <button class="btn" :disabled="!canSubmit" @click="submit">
          {{ busy ? '处理中…' : mode === 'browser' ? '打开浏览器登录' : '保存' }}
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

.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.modes {
  display: inline-flex;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  overflow: hidden;
  width: max-content;
}

.seg {
  padding: 4px 10px;
  border: 0;
  background: var(--panel);
  color: var(--text-dim);
  font-size: 12px;
}

.seg.on {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
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
