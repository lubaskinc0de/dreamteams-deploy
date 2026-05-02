{{- define "dreamteams_ingress.rateLimitMiddleware" }}
---
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: {{ .name }}
  namespace: {{ .namespace }}
spec:
  rateLimit:
    average: {{ .limit.average }}
    burst: {{ .limit.burst }}
    period: {{ .limit.period | quote }}
    {{- with .root.Values.rateLimits.sourceCriterion }}
    sourceCriterion:
      {{- toYaml . | nindent 6 }}
    {{- end }}
    {{- $redis := default (dict) .root.Values.rateLimits.redis }}
    {{- if $redis.enabled }}
    redis:
      {{- omit $redis "enabled" | toYaml | nindent 6 }}
    {{- end }}
{{- end }}

{{- define "dreamteams_ingress.longRateLimitMiddleware" }}
{{- $cfg := .root.Values.rateLimits.longWindow }}
{{- if $cfg.enabled }}
{{- $limit := dict "average" (mul (int .limit.average) (int $cfg.averageMultiplier)) "burst" (mul (int .limit.burst) (int $cfg.burstMultiplier)) "period" $cfg.period }}
{{ include "dreamteams_ingress.rateLimitMiddleware" (dict "root" .root "name" (printf "%s-%s" .name $cfg.suffix) "namespace" .namespace "limit" $limit) }}
{{- end }}
{{- end }}

{{- define "dreamteams_ingress.longRateLimitRef" -}}
{{- if .root.Values.rateLimits.longWindow.enabled }}
- name: {{ printf "%s-%s" .name .root.Values.rateLimits.longWindow.suffix }}
  namespace: {{ .namespace }}
{{- end }}
{{- end }}

{{- define "dreamteams_ingress.securityHeadersRef" -}}
{{- if .Values.securityHeaders.enabled }}
- name: security-headers
  namespace: dreamteams
{{- end }}
{{- end }}

{{- define "dreamteams_ingress.anubisApiAuthRef" -}}
{{- if .Values.anubisApiAuth.enabled }}
- name: anubis-api-auth
  namespace: dreamteams
{{- end }}
{{- end }}
