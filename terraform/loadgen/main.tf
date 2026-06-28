# ---------------------------------------------------------------------------
# Glasshouse — In-Region Load Generator (standalone Terraform config)
#
# A t3.medium in us-east-1 running k6, hitting the app origin directly over
# AWS's internal network. Removes the two problems with laptop-based testing:
# weak/unstable load generation and trans-Pacific latency noise.
#
#   terraform apply    -> spin up the load generator
#   terraform destroy  -> tear it down (removes its SG rule on the app SG)
#
# Standalone config (separate state). References existing infra via data
# sources; never touches the main app config's state.
# ---------------------------------------------------------------------------

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "your_ip" {
  description = "Your IP CIDR for SSH to the load generator"
  type        = string
}

variable "key_name" {
  type    = string
  default = "vault-key"
}

variable "loadgen_instance_type" {
  description = "Generator size — t3.medium pushes hundreds of VUs without the generator itself bottlenecking"
  type        = string
  default     = "t3.medium"
}

# --- look up existing infrastructure ---
data "aws_vpc" "main" {
  filter {
    name   = "tag:Name"
    values = ["vault-vpc"]
  }
}

data "aws_subnet" "public" {
  filter {
    name   = "tag:Name"
    values = ["vault-public-subnet"]
  }
}

data "aws_security_group" "app" {
  filter {
    name   = "tag:Name"
    values = ["vault-ec2-sg"]
  }
}

data "aws_ami" "amazon_linux" {
  most_recent = true
  owners      = ["amazon"]
  filter {
    name   = "name"
    values = ["amzn2-ami-hvm-*-x86_64-gp2"]
  }
}

# --- load generator security group ---
resource "aws_security_group" "loadgen" {
  name        = "glasshouse-loadgen-sg"
  description = "Load generator: SSH from operator, egress all"
  vpc_id      = data.aws_vpc.main.id

  ingress {
    description = "SSH from operator"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.your_ip]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "glasshouse-loadgen-sg" }
}

# --- allow the load generator to hit the app origin on 443 (identity-based) ---
# Lives in this config so destroy cleans it up.
resource "aws_security_group_rule" "app_allow_loadgen" {
  type                     = "ingress"
  from_port                = 443
  to_port                  = 443
  protocol                 = "tcp"
  security_group_id        = data.aws_security_group.app.id
  source_security_group_id = aws_security_group.loadgen.id
  description              = "Allow Glasshouse load generator to hit origin :443 for capacity testing"
}

# --- the load generator instance ---
resource "aws_instance" "loadgen" {
  ami                    = data.aws_ami.amazon_linux.id
  instance_type          = var.loadgen_instance_type
  subnet_id              = data.aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.loadgen.id]
  key_name               = var.key_name

  user_data = <<-EOF
    #!/bin/bash
    yum update -y
    yum install -y git
    # install k6 from the official repo
    cat > /etc/yum.repos.d/k6.repo << 'REPO'
    [k6]
    name=k6
    baseurl=https://dl.k6.io/rpm/x86_64
    enabled=1
    gpgcheck=0
    REPO
    yum install -y k6
    cd /home/ec2-user
    git clone https://github.com/awsomesud347/Glasshouse.git
    chown -R ec2-user:ec2-user Glasshouse
  EOF

  tags = { Name = "glasshouse-loadgen" }
}

output "loadgen_public_ip" {
  value = aws_instance.loadgen.public_ip
}

output "app_private_ip" {
  description = "App private IP — origin-direct target for the load test (private path)"
  value       = data.aws_instances.app.private_ips[0]
}

data "aws_instances" "app" {
  filter {
    name   = "tag:Name"
    values = ["vault-ec2"]
  }
  instance_state_names = ["running"]
}
