{{/* Name of every object of the release. */}}
{{- define "markets.fullname" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Labels that select the Pods; never change them after the first install (selectors are immutable). */}}
{{- define "markets.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* Labels on every object. */}}
{{- define "markets.labels" -}}
{{ include "markets.selectorLabels" . }}
app.kubernetes.io/version: {{ .Values.image.tag | trunc 63 | trimSuffix "-" | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/* Restricted security context of every container. */}}
{{- define "markets.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
{{- end -}}

{{/* Name of the ConfigMap with the runtime configuration file (kept apart from the environment ConfigMap). */}}
{{- define "markets.runtimeConfigMap" -}}
{{ include "markets.fullname" . }}-runtime
{{- end -}}

{{/* The directory the runtime ConfigMap is mounted at, and the file in it that RUNTIME_CONFIG_FILE names. */}}
{{- define "markets.runtimeDir" -}}
/etc/markets/runtime
{{- end -}}

{{- define "markets.runtimeFile" -}}
{{ include "markets.runtimeDir" . }}/runtime.env
{{- end -}}

{{/* The base URL of trading's internal funding endpoint (TRADING_URL). */}}
{{- define "markets.tradingUrl" -}}
http://{{ .Values.trading.host }}:{{ .Values.trading.port }}
{{- end -}}
