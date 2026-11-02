terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.71"
    }
  }

  backend "s3" {
    bucket       = "tf-bootstrap-clamux-145302888455"
    key          = "remote-bridge/terraform.tfstate"
    region       = "eu-west-1"
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region = "eu-west-1"
}

resource "aws_vpc" "vpc_clamux" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = false

  tags = {
    Name = "Clamux VPC"
  }
}

resource "aws_internet_gateway" "vpc_gateway_clamux" {
  vpc_id = aws_vpc.vpc_clamux.id

  tags = {
    Name = "Clamux Main Gateway"
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_subnet" "vpc_subnet_primary_clamux" {
  vpc_id                  = aws_vpc.vpc_clamux.id
  cidr_block              = "10.0.1.0/24"
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = false

  tags = {
    Name = "Clamux Primary Subnet"
  }
}

resource "aws_subnet" "vpc_subnet_secondary_clamux" {
  vpc_id                  = aws_vpc.vpc_clamux.id
  cidr_block              = "10.0.2.0/24"
  availability_zone       = data.aws_availability_zones.available.names[1]
  map_public_ip_on_launch = false

  tags = {
    Name = "Clamux Secondary Subnet"
  }
}

resource "aws_route_table" "vpc_route_table_clamux" {
  vpc_id = aws_vpc.vpc_clamux.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.vpc_gateway_clamux.id
  }

  tags = {
    Name = "Clamux VPC Route Table"
  }
}

resource "aws_route_table_association" "vpc_route_table_association_primary_clamux" {
  subnet_id      = aws_subnet.vpc_subnet_primary_clamux.id
  route_table_id = aws_route_table.vpc_route_table_clamux.id
}

resource "aws_route_table_association" "vpc_route_table_association_secondary_clamux" {
  subnet_id      = aws_subnet.vpc_subnet_secondary_clamux.id
  route_table_id = aws_route_table.vpc_route_table_clamux.id
}
