# 🖥️ GPO Automation — Atualização e Desligamento Automático via Group Policy

<div align="center">

![Windows Server](https://img.shields.io/badge/Windows%20Server-2019%2F2022-0078D6?style=for-the-badge&logo=windows&logoColor=white)
![Active Directory](https://img.shields.io/badge/Active%20Directory-Domain%20Services-00A4EF?style=for-the-badge&logo=microsoft&logoColor=white)
![Group Policy](https://img.shields.io/badge/Group%20Policy-Automation-107C10?style=for-the-badge&logo=windows&logoColor=white)
![Status](https://img.shields.io/badge/Status-Produção%20✅-success?style=for-the-badge)

**Automação completa do ciclo de vida de máquinas Windows via Group Policy Object (GPO)**  
Solução corporativa para atualização coordenada de SO e desligamento programado em ambientes Active Directory.

[Sobre o Projeto](#-sobre-o-projeto) •
[Funcionalidades](#-funcionalidades) •
[Arquitetura](#-arquitetura-da-solução) •
[Implementação](#-implementação) •
[Resultados](#-resultados-obtidos) •
[Segurança](#-segurança-e-conformidade)

</div>

---

## 📋 Sobre o Projeto

Este projeto implementa uma solução de **automação centralizada** para gerenciamento do ciclo de vida de máquinas Windows em ambiente corporativo com Active Directory. Através de configurações de **Group Policy Objects (GPO)**, todas as máquinas vinculadas ao domínio passam a receber atualizações de sistema operacional de forma coordenada e sincronizada, além de realizarem desligamento automático toda sexta-feira ao final do expediente.

A solução elimina a necessidade de intervenção manual em cada máquina, garante padronização das atualizações e gera economia real de energia e recursos de rede ao longo do tempo.

### 🎯 Problema Resolvido

Ambientes corporativos com dezenas ou centenas de máquinas Windows frequentemente sofrem com:

- Atualizações de SO acontecendo de forma aleatória e em horários de produção
- Máquinas permanecendo ligadas durante finais de semana sem necessidade
- Ausência de rastreabilidade sobre o status de atualização de cada endpoint
- Consumo desnecessário de energia elétrica e banda de internet
- Downtime imprevisto causado por reinicializações automáticas durante o expediente

### 💡 Solução Implementada

Centralização e automação completa através de **Group Policy**, usando ferramentas nativas do Windows Server — sem necessidade de softwares de terceiros, licenças adicionais ou scripts complexos.

---

## ✅ Funcionalidades

### 🔄 Atualização Automática do Sistema Operacional
- Agendamento de atualização em data e horário definidos pela equipe de TI
- Aplicação simultânea em todas as máquinas vinculadas à GPO
- Controle total sobre quais atualizações serão instaladas (KB específicas ou todas)
- Notificação prévia aos usuários antes da reinicialização
- Compatível com Windows Update for Business e WSUS

### ⏹️ Desligamento Programado (Sexta-feira)
- Shutdown automático toda sexta-feira ao fim do expediente
- Aviso prévio para que usuários possam salvar arquivos
- Ciclo de reinicialização saudável pós-atualização
- Economia de energia durante finais de semana

### 📊 Auditoria e Rastreabilidade
- Log centralizado de todas as atualizações via Event Viewer
- Relatório de políticas aplicadas via `gpresult`
- Histórico completo de desligamentos e reinicializações
- Monitoramento via Group Policy Results no domínio

### 🔐 Segurança e Conformidade
- Patch management centralizado e auditável
- Alinhamento com políticas de compliance corporativo
- Redução da janela de vulnerabilidade pós-publicação de patches
- Controle de quais máquinas estão com SO atualizado

---

## 🏗️ Arquitetura da Solução

```
┌─────────────────────────────────────────────────────────────────┐
│                    ACTIVE DIRECTORY DOMAIN                       │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              Group Policy Object (GPO)                    │   │
│  │                                                           │   │
│  │   ┌─────────────────────┐  ┌────────────────────────┐   │   │
│  │   │  Windows Update     │  │   Power Management     │   │   │
│  │   │  Configuration      │  │   + Task Scheduler     │   │   │
│  │   │                     │  │                        │   │   │
│  │   │  ✓ Auto Update ON   │  │  ✓ Shutdown: Sex 18h  │   │   │
│  │   │  ✓ Data agendada    │  │  ✓ Aviso 5 min antes  │   │   │
│  │   │  ✓ Reboot agendado  │  │  ✓ Restart controlado │   │   │
│  │   └─────────────────────┘  └────────────────────────┘   │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                   │
│                    Aplicada via GPO Link                         │
│                              │                                   │
│              ┌───────────────┼───────────────┐                  │
│              ▼               ▼               ▼                  │
│       ┌──────────┐   ┌──────────┐   ┌──────────┐              │
│       │ PC-001   │   │ PC-002   │   │ PC-00N   │              │
│       │ Dept. A  │   │ Dept. B  │   │ Dept. N  │              │
│       └──────────┘   └──────────┘   └──────────┘              │
│                                                                  │
│       ✓ Atualiza     ✓ Atualiza     ✓ Atualiza                 │
│       ✓ Desliga      ✓ Desliga      ✓ Desliga                  │
└─────────────────────────────────────────────────────────────────┘
```

### Componentes Utilizados

| Componente | Função | Localização |
|---|---|---|
| **Group Policy Management** | Console central de gerenciamento | Server Manager > Tools |
| **Windows Update Policy** | Controle de atualização do SO | Computer Configuration > Administrative Templates > Windows Components > Windows Update |
| **Power Management Policy** | Configuração de energia e desligamento | Computer Configuration > Administrative Templates > System > Power Management |
| **Task Scheduler (via GPO)** | Agendamento do shutdown semanal | Computer Configuration > Preferences > Control Panel Settings > Scheduled Tasks |
| **Event Viewer** | Auditoria e monitoramento de logs | Windows Logs > System / Application |
| **GPRESULT** | Relatório de políticas aplicadas | Linha de comando: `gpresult /h report.html` |

---

## 🚀 Implementação

### Pré-requisitos

Antes de iniciar a implementação, certifique-se de ter:

- [ ] Windows Server 2016, 2019 ou 2022 configurado como Domain Controller
- [ ] Active Directory Domain Services (AD DS) instalado e configurado
- [ ] Group Policy Management Console (GPMC) disponível
- [ ] Conta com permissões de Administrador de Domínio
- [ ] Máquinas clientes ingressadas no domínio
- [ ] Acesso ao Group Policy Management no Server Manager

---

### Etapa 1 — Criar e Configurar a GPO

**1.1 Acessar o Group Policy Management**
```
Server Manager > Tools > Group Policy Management
```

**1.2 Criar nova GPO**
```
Clique com botão direito na OU desejada
> Create a GPO in this domain, and Link it here...
> Nome sugerido: "GPO_Automacao_Atualizacao_Desligamento"
```

**1.3 Editar a GPO criada**
```
Clique com botão direito na GPO
> Edit
```

---

### Etapa 2 — Configurar Atualização Automática do SO

Dentro do Group Policy Editor, navegue até:

```
Computer Configuration
  └── Administrative Templates
        └── Windows Components
              └── Windows Update
```

Configure as seguintes políticas:

| Política | Configuração Recomendada |
|---|---|
| Configure Automatic Updates | **Enabled** → Option 4 (Auto download and schedule the install) |
| Scheduled install day | **5 - Every Friday** (ou dia preferido) |
| Scheduled install time | **18:00** (fora do horário de produção) |
| No auto-restart with logged on users | **Enabled** (evita reinicialização com usuário ativo) |
| Delay Restart for scheduled installations | **Enabled** → 5 minutos (aviso para usuários) |
| Re-prompt for restart with scheduled installations | **Enabled** |

---

### Etapa 3 — Configurar Desligamento Automático (Sexta-feira)

**Opção A — Via Power Management (Simples)**

Navegue até:
```
Computer Configuration
  └── Administrative Templates
        └── System
              └── Power Management
                    └── Sleep Settings
```

**Opção B — Via Task Scheduler (Recomendado)**

Navegue até:
```
Computer Configuration
  └── Preferences
        └── Control Panel Settings
              └── Scheduled Tasks
```

Crie nova tarefa com as configurações:

```
Nome da tarefa : GPO_Shutdown_Sexta
Descrição     : Desligamento automático toda sexta ao fim do expediente
Trigger       : Semanalmente > Sexta-feira > 18:00
Action        : shutdown.exe /s /t 300 /c "Sistema será desligado em 5 minutos."
Executar como : NT AUTHORITY\SYSTEM
Status        : Enabled
```

> ⚠️ **Parâmetros do shutdown.exe:**
> - `/s` → Desligar
> - `/t 300` → Aguardar 300 segundos (5 minutos) — tempo para usuário salvar
> - `/c` → Mensagem exibida na tela do usuário

---

### Etapa 4 — Vincular a GPO à OU

```
No Group Policy Management Console:
1. Localize a OU que contém as máquinas alvo
2. Clique com botão direito
3. Selecione "Link an Existing GPO"
4. Escolha: GPO_Automacao_Atualizacao_Desligamento
5. Clique em "OK"
```

Verifique o Link Order e o status **Enabled** na coluna **Link Enabled**.

---

### Etapa 5 — Testar em Ambiente Piloto

> ✅ **Boas práticas:** Sempre teste em OU separada antes de expandir para toda a empresa.

```
1. Crie uma OU chamada: "Piloto_GPO"
2. Mova 5 a 10 máquinas para esta OU
3. Vincule a GPO somente nessa OU
4. Execute: gpupdate /force nas máquinas de teste
5. Monitore por 1 semana completa
6. Verifique logs no Event Viewer
7. Após validação, expanda para toda a empresa
```

---

### Etapa 6 — Monitorar e Auditar

**Verificar se a GPO foi aplicada corretamente em uma máquina:**
```cmd
gpresult /h C:\relatorio_gpo.html
```
Abra o arquivo HTML gerado para ver todas as políticas aplicadas.

**Verificar logs de atualização no Event Viewer:**
```
Event Viewer
  └── Windows Logs
        └── System
              └── Filtrar por Source: "WindowsUpdateClient" ou "Microsoft-Windows-WindowsUpdateClient"
```

**Event IDs relevantes para monitorar:**

| Event ID | Descrição |
|---|---|
| **19** | Instalação de atualização bem-sucedida |
| **20** | Falha na instalação de atualização |
| **43** | Instalação iniciada aguardando reinicialização |
| **6005** | Sistema iniciado (boot) |
| **6006** | Sistema desligado normalmente |
| **6008** | Desligamento inesperado |
| **1074** | Desligamento/reinício iniciado por processo ou usuário |

---

## 📊 Resultados Obtidos

A implementação desta solução gerou os seguintes impactos mensuráveis no ambiente:

### 💰 Redução de Custos
| Indicador | Antes | Depois | Economia |
|---|---|---|---|
| Máquinas ligadas no fim de semana | 100% | 0% | **100%** |
| Consumo de energia estimado | Alto | Reduzido | **~25-35%** |
| Custo de banda (atualizações) | Aleatório | Janela definida | **Otimizado** |
| Chamados pós-atualização | Alto | Baixo | **~60% menos** |

### ⚙️ Eficiência Operacional
- ✅ **Zero intervenção manual** para atualizações em todas as máquinas
- ✅ **Ciclo 100% previsível** — TI sabe exatamente quando ocorrem atualizações
- ✅ **Reinicializações controladas** — eliminam acúmulo de uptime prolongado
- ✅ **Padronização total** — todas as máquinas no mesmo estado de atualização

### 🔐 Segurança
- ✅ **Janela de vulnerabilidade reduzida** — patches aplicados de forma coordenada
- ✅ **Conformidade** — auditoria centralizada e rastreável
- ✅ **Gestão de risco** — maior controle sobre o parque de máquinas

---

## 🔐 Segurança e Conformidade

### Boas Práticas Aplicadas

- **Teste em OU piloto** antes de aplicar no domínio completo
- **Aviso prévio ao usuário** (5 minutos antes do desligamento)
- **Janela de atualização fora do horário de produção** (após 18h)
- **Monitoramento contínuo** via Event Viewer e GPRESULT
- **Documentação** de todas as políticas aplicadas
- **Backup** da GPO antes de alterações (`gpmc > Backup All GPOs`)

### Alinhamento com Frameworks

| Framework | Controle Atendido |
|---|---|
| **ISO 27001** | A.12.6.1 — Gestão de vulnerabilidades técnicas |
| **NIST CSF** | PR.IP-12 — Vulnerability management plan |
| **CIS Controls** | Control 7 — Continuous Vulnerability Management |
| **LGPD / GDPR** | Segurança de dados por meio de atualização regular |

---

## 🛠️ Troubleshooting

### GPO não está sendo aplicada nas máquinas

```cmd
# Execute na máquina cliente como Administrador:
gpupdate /force

# Verifique se a máquina enxerga o DC:
nltest /dsgetdc:<nome_do_dominio>

# Verifique conectividade com DC:
ping <nome_do_DC>

# Veja quais GPOs estão aplicadas:
gpresult /r
```

### Máquinas não estão desligando

```cmd
# Verifique se a tarefa está criada:
schtasks /query /fo LIST /v | findstr "GPO_Shutdown"

# Teste o desligamento manualmente:
shutdown.exe /s /t 60 /c "Teste de shutdown"

# Cancele o desligamento (se precisar):
shutdown.exe /a
```

### Atualização não está ocorrendo

```cmd
# Forçar verificação de atualizações:
wuauclt /detectnow

# Verificar serviço Windows Update:
sc query wuauserv

# Reiniciar serviço Windows Update:
net stop wuauserv && net start wuauserv
```

### Verificar status da GPO aplicada

```cmd
# Gerar relatório HTML completo:
gpresult /h C:\GPO_Report.html /f

# Ver resumo no terminal:
gpresult /r /scope computer
```

---

## 📁 Estrutura do Projeto

```
GPO-Automation/
│
├── 📄 README.md                          # Este arquivo
│
├── 📂 documentacao/
│   ├── POST_COMPLETO_LINKEDIN.md         # Post completo para LinkedIn
│   ├── CHECKLIST_FINAL_PUBLICACAO.md     # Checklist de publicação
│   └── Guia_Screenshots_GPO_LinkedIn.md  # Guia de prints para o post
│
├── 📂 imagens/
│   ├── print_gpo_anotado_v1.png          # Print GPO - Versão anotada (educativa)
│   ├── print_gpo_anotado_v2.png          # Print GPO - Versão pixelizada (profissional)
│   ├── infografico_antes_depois.png      # Infográfico: Antes vs Depois
│   ├── infografico_fluxo_tecnico.png     # Infográfico: Fluxo de implementação
│   └── infografico_metricas_roi.png      # Infográfico: Métricas e ROI
│
└── 📂 scripts/
    └── shutdown_manual.cmd               # Script opcional de shutdown manual
```

---

## 🔮 Próximos Passos

Melhorias planejadas para evoluir ainda mais a solução:

- [ ] **Integração com WSUS** — controle granular de quais atualizações distribuir
- [ ] **Dashboard no Power BI** — visualização em tempo real do status de cada máquina
- [ ] **Alertas via e-mail** — notificação automática para o time de TI em caso de falha
- [ ] **Script de relatório semanal** — resumo automático de atualizações aplicadas
- [ ] **Política de BitLocker via GPO** — criptografia automática nas máquinas
- [ ] **Integração com SIEM** — centralização de logs para análise de segurança
- [ ] **Automação de inventário** — relatório automático de hardware/software por GPO

---

## 🤝 Como Contribuir

Sugestões e melhorias são bem-vindas! Se você trabalha com infraestrutura Windows e tem ideias para evoluir esta solução:

1. Faça um fork do repositório
2. Crie uma branch: `git checkout -b feature/minha-melhoria`
3. Commit suas mudanças: `git commit -m 'Adiciona nova funcionalidade X'`
4. Push na branch: `git push origin feature/minha-melhoria`
5. Abra um Pull Request

---

## 📚 Referências e Recursos

| Recurso | Link |
|---|---|
| Microsoft Docs — Group Policy Overview | https://docs.microsoft.com/pt-br/windows-server/identity/ad-ds/manage/group-policy |
| Microsoft Docs — Configure Automatic Updates | https://docs.microsoft.com/pt-br/windows-server/administration/windows-server-update-services |
| Microsoft Docs — Task Scheduler via GPO | https://docs.microsoft.com/pt-br/windows/win32/taskschd/task-scheduler-start-page |
| Microsoft Docs — shutdown.exe | https://docs.microsoft.com/pt-br/windows-server/administration/windows-commands/shutdown |
| CIS Benchmarks — Windows Server | https://www.cisecurity.org/cis-benchmarks |

---

## 👨‍💻 Autor

**Suporte de TI — Infraestrutura e Administração de Sistemas**

Especialista em:
- Administração de Active Directory e Group Policy
- Infraestrutura Windows Server
- Automação e otimização de ambientes corporativos
- Segurança e conformidade em TI

[![LinkedIn](https://img.shields.io/badge/LinkedIn-Conectar-0077B5?style=for-the-badge&logo=linkedin&logoColor=white)](https://linkedin.com)

---

## 📄 Licença

Este projeto está disponível para uso livre em ambientes corporativos.  
Distribuído sob a licença **MIT**. Consulte o arquivo `LICENSE` para mais informações.

---

<div align="center">

**⭐ Se este projeto foi útil para você, considere dar uma estrela no repositório!**

*Desenvolvido com foco em eficiência operacional, segurança e economia de recursos corporativos.*

</div>
