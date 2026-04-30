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

{{- define "dreamteams_ingress.securityHeadersRef" -}}
{{- if .Values.securityHeaders.enabled }}
- name: security-headers
  namespace: dreamteams
{{- end }}
{{- end }}
